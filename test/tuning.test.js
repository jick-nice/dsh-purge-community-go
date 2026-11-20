// 社区版运行时开关：tuning.json 的默认值/校验，以及 30 分钟过期的运行时探针。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readTuning, writeTuning, BOOST_TEXT, readProbe, createProbe, probeText, clearProbe, PROBE_TTL_MS } from '../lib/community.js'
import { tuningPath, probePath } from '../lib/home.js'
import { tempHome, clean } from './helpers.mjs'

test('默认值：强化段开、注入位置 head、无额外补丁', () => {
  const home = tempHome()
  try {
    const t = readTuning(home)
    assert.equal(t.boost, true)
    assert.equal(t.injectPosition, 'head')
    assert.deepEqual(t.extraPatches, [])
    assert.equal(fs.existsSync(tuningPath(home)), false)
  } finally {
    clean(home)
  }
})

test('写入会落盘；非法位置回落到 head；extraPatches 去重排序', () => {
  const home = tempHome()
  try {
    const t = writeTuning(home, { injectPosition: 'tail', extraPatches: [19, 18, 18, 'x', 0, -3] })
    assert.equal(t.injectPosition, 'tail')
    assert.deepEqual(t.extraPatches, [18, 19])
    assert.ok(fs.existsSync(tuningPath(home)))

    const bad = writeTuning(home, { injectPosition: 'middle' })
    assert.equal(bad.injectPosition, 'head')
  } finally {
    clean(home)
  }
})

test('读到坏 JSON 时退回默认值，不抛', () => {
  const home = tempHome()
  try {
    fs.mkdirSync(tuningPath(home).replace(/tuning\.json$/, ''), { recursive: true })
    fs.writeFileSync(tuningPath(home), '{ broken')
    const t = readTuning(home)
    assert.equal(t.boost, true)
    assert.equal(t.injectPosition, 'head')
  } finally {
    clean(home)
  }
})

test('强化段正文带覆盖语义标签', () => {
  assert.ok(BOOST_TEXT.startsWith('<dsh_boost'))
  assert.ok(BOOST_TEXT.includes('priority="override"'))
  assert.ok(BOOST_TEXT.trim().endsWith('</dsh_boost>'))
})

test('探针：写入后能被读到，正文里带 nonce', () => {
  const home = tempHome()
  try {
    assert.equal(readProbe(home), null)
    const probe = createProbe(home)
    assert.match(probe.nonce, /^purge-[0-9a-f]{8}$/)
    assert.equal(readProbe(home).nonce, probe.nonce)
    const text = probeText(home)
    assert.ok(text.includes(probe.nonce))
    assert.ok(text.startsWith('<dsh_probe>'))
  } finally {
    clean(home)
  }
})

test('探针过期（30 分钟）自动失效并删文件', () => {
  const home = tempHome()
  try {
    const probe = createProbe(home)
    const raw = JSON.parse(fs.readFileSync(probePath(home), 'utf8'))
    fs.writeFileSync(probePath(home), JSON.stringify({ ...raw, at: Date.now() - PROBE_TTL_MS - 1000 }))
    assert.equal(readProbe(home), null)
    assert.equal(fs.existsSync(probePath(home)), false)
    assert.equal(probeText(home), '')
    assert.equal(clearProbe(home), true)
  } finally {
    clean(home)
  }
})
