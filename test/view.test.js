// 面板数据：snapshot 的字段、补丁层缓存的命中与失效、面板骨架的绑定路径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { snapshot, patchSnapshot, invalidatePatches, statusCard, stripData, panelView } from '../lib/view.js'
import { buildView, patchAdvice } from '../lib/dshgo.js'
import { seedInject } from '../lib/prompt.js'
import { writeTuning } from '../lib/community.js'
import { tempHome, tempEngine, writePkgFile, clean, SANDBOX_POLICY_SOURCE } from './helpers.mjs'

test('snapshot：注入层字段齐全，位置/强化段跟随 tuning', () => {
  const home = tempHome()
  const bare = tempHome()
  try {
    seedInject(home)
    writeTuning(home, { boost: false, injectPosition: 'both' })
    const snap = snapshot(home)
    assert.equal(snap.enabled, true)
    assert.ok(snap.bytes > 20_000)
    // 落盘之后正文来源就是 prompt-inject.md（用户可改的那份）
    assert.equal(snap.source, 'prompt-inject.md')
    assert.equal(snap.sourceLabel, 'prompt-inject.md')
    assert.equal(snap.injectPosition, 'both')
    assert.equal(snap.boost, false)
    assert.equal(snap.probe, null)
    assert.equal(stripData(snap, 'zh').tone, 'good')
    assert.ok(stripData(snap, 'zh').text.length <= 24)

    // 没落盘的新 HOME 走包内正文
    const builtinSnap = snapshot(bare)
    assert.equal(builtinSnap.source, 'builtin')
    assert.equal(builtinSnap.sourceLabel, '包内默认正文')
  } finally {
    clean(home, bare)
  }
})

test('patchSnapshot：扫描失败不缓存、不抛（找不到引擎目录）', () => {
  invalidatePatches()
  const bad = patchSnapshot('/definitely/not/a/real/engine/root')
  assert.equal(bad.ok, true)
  assert.equal(bad.total, 88)
  assert.ok(bad.rows.every((r) => r.status === 'no_pkg' || r.status === 'no_file'))
  // 只有 dsh-base 的假引擎：base 上的补丁是 no_file，其余 no_pkg
  const root = tempEngine()
  try {
    const good = patchSnapshot(root)
    assert.equal(good.ok, true)
    assert.equal(good.total, 88)
    assert.ok(good.applicable >= 0)
  } finally {
    clean(root)
  }
})

test('patchSnapshot：同一 root 30 秒内走缓存，invalidate 后重扫', () => {
  const root = tempEngine()
  try {
    const file = writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    invalidatePatches()
    const first = patchSnapshot(root)
    const row93 = first.rows.find((r) => r.id === 93)
    assert.equal(row93.status, 'hit')

    // 后台改文件，缓存期内数字不变
    writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE.replace(/Current DSH file policy: /, 'Current file policy: '))
    const cached = patchSnapshot(root)
    assert.equal(cached.rows.find((r) => r.id === 93).status, 'hit')

    invalidatePatches()
    const fresh = patchSnapshot(root)
    // 三条 pattern 只替掉了一条 → 部分命中，不是全绿
    assert.equal(fresh.rows.find((r) => r.id === 93).status, 'partial')
  } finally {
    clean(root)
  }
})

test('工具卡与面板视图都能出去（不抛、体积可控）', () => {
  const home = tempHome()
  const root = tempEngine()
  try {
    seedInject(home)
    const snap = snapshot(home)
    for (const view of [statusCard(snap, 'zh'), statusCard(snap, 'en'), panelView(snap, { locale: 'zh' })]) {
      assert.equal(view.type, 'stack')
      assert.ok(JSON.stringify(view).length < 16 * 1024)
    }
  } finally {
    clean(home, root)
  }
})

test('面板骨架只含绑定路径，不含任何扫描结果', () => {
  const view = buildView()
  const json = JSON.stringify(view)
  assert.ok(json.includes('"$":"data.tone"'))
  assert.ok(json.includes('"$":"data.patchText"'))
  assert.ok(json.length < 4 * 1024)
  const actions = view.children.find((c) => c.type === 'actions')
  assert.equal(actions.items.length, 4)
  assert.deepEqual(actions.items.map((i) => i.action), ['refresh', 'oneClick', 'toggle', 'patchRevert'])
})

test('patchAdvice：不同状态给不同结论，桌面专属不强求', () => {
  assert.equal(patchAdvice({ status: 'applied' }), '已生效，不用管')
  assert.equal(patchAdvice({ status: 'partial' }), '不用管（命中那套已经生效）')
  assert.equal(patchAdvice({ status: 'no_pkg' }), '不用管（手机上没有这个包）')
  assert.equal(patchAdvice({ status: 'hit' }), '可以再打一次')
  assert.equal(patchAdvice({ status: 'drifted' }), '可以再打一次（被升级冲掉）')
  assert.ok(patchAdvice({ status: 'miss', name: 'PRESET_STANDARD_X' }).includes('不用管'))
  assert.ok(patchAdvice({ status: 'miss', name: 'UNKNOWN_THING', desktopOnly: true }).includes('桌面专属'))
  assert.ok(patchAdvice({ status: 'miss', name: 'UNKNOWN_THING' }).includes('需要看一眼'))
})
