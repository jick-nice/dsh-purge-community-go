// 补丁计数口径：面板「全绿」只取决于 pending，不能把「这版引擎没有」算成待处理。
//
// 这条是真实故障的回放：某台手机上 88 条里 65 已生效、2 部分命中、1 被冲掉、
// 5 打不上、6 路径不在、9 桌面专属。旧口径把 miss / no_file 也算待处理，
// 于是面板永远显示「12 条需要处理」，用户怎么点都消不掉。
import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyRows, patchAdvice } from '../lib/dshgo.js'

/** 造 rows：status → 条数。 */
function rows(dist) {
  const out = []
  let id = 0
  for (const [status, n, extra] of dist) {
    for (let i = 0; i < n; i += 1) {
      id += 1
      out.push({ id, name: `${status.toUpperCase()}_${id}`, status, ...(extra || {}) })
    }
  }
  return out
}

const REAL = [
  ['applied', 65],
  ['partial', 2],
  ['drifted', 1],
  ['miss', 5],
  ['no_file', 6],
  ['no_pkg', 9],
]

test('四类互斥且穷尽：加起来等于行数', () => {
  const list = rows(REAL)
  const c = classifyRows(list)
  assert.equal(list.length, 88)
  assert.equal(c.covered + c.pending + c.gap + c.desktop, 88)
})

test('真实分布：待处理只剩 1 条（被冲掉的那条），不是 12 条', () => {
  const c = classifyRows(rows(REAL))
  assert.equal(c.covered, 67, '已生效 65 + 部分命中 2')
  assert.equal(c.pending, 1, '只有 drifted 是点一下能解决的')
  assert.equal(c.gap, 11, '5 打不上 + 6 路径不在')
  assert.equal(c.desktop, 9, 'no_pkg 必须计入桌面专属')
  assert.equal(c.actionable, 68, '分母只放本机能打上的')
})

test('点一次「一键注入」后就是全绿（68/68）', () => {
  const list = rows(REAL).map((row) => (row.status === 'drifted' ? { ...row, status: 'applied' } : row))
  const c = classifyRows(list)
  assert.equal(c.pending, 0)
  assert.equal(c.covered, 68)
  assert.equal(c.actionable, 68)
  assert.equal(`${c.covered}/${c.actionable}`, '68/68')
})

test('opt-in 的两条不算待处理（默认不打）', () => {
  const list = rows([['applied', 60], ['hit', 1, { optIn: true }], ['miss', 1, { optIn: true }], ['no_pkg', 2]])
  const c = classifyRows(list)
  assert.equal(c.optInWaiting, 1)
  assert.equal(c.pending, 0, 'hit 的那条是 opt-in，不该催')
})

test('空表、全桌面、全生效三种边界', () => {
  assert.deepEqual(
    [classifyRows([]).covered, classifyRows([]).pending, classifyRows([]).actionable],
    [0, 0, 0],
  )
  const desk = classifyRows(rows([['no_pkg', 88]]))
  assert.equal(desk.desktop, 88)
  assert.equal(desk.actionable, 0)
  const done = classifyRows(rows([['applied', 70], ['partial', 3]]))
  assert.equal(done.pending, 0)
  assert.equal(done.covered, 73)
  assert.equal(done.actionable, 73)
})

test('未知状态不会把计数撑大', () => {
  const c = classifyRows([{ id: 1, status: 'weird' }, { id: 2, status: 'applied' }])
  assert.equal(c.covered, 1)
  assert.equal(c.pending + c.gap + c.desktop, 0)
})

test('patchAdvice 对每种状态都给出「不用管 / 要做」的明确结论', () => {
  const expect = {
    applied: /不用管/,
    partial: /不用管/,
    no_pkg: /不用管/,
    no_needle: /不用管/,
    miss: /不用管/,
    no_file: /不用管/,
    hit: /再打一次/,
    drifted: /再打一次/,
  }
  for (const [status, re] of Object.entries(expect)) {
    assert.match(patchAdvice({ status, name: 'SOME_PATCH' }), re, `${status} 的说明不对`)
  }
})