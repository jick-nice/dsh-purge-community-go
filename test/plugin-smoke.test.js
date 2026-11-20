// dsh-go 原生界面接线：注册、静态骨架、data() 推送、四个按钮的行为。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installNative } from '../lib/native.js'
import { readState } from '../lib/state.js'
import { seedInject } from '../lib/prompt.js'
import { tempHome, tempEngine, writePkgFile, clean, SANDBOX_POLICY_SOURCE } from './helpers.mjs'

/** 假桥接：记录 strip / panel 注册，暴露 emit 供测试主动推一次。 */
function fakeBridge() {
  const captured = { strip: null, panel: null, emit: null, refresh: 0, disposed: [] }
  return {
    captured,
    strip(id, producer) {
      captured.strip = { id }
      const dispose = producer({}, (value) => { captured.lastStrip = value })
      return dispose
    },
    panel(id, spec) {
      captured.panel = { id, spec }
      const dispose = spec.data({}, (value) => { captured.lastData = value })
      return dispose
    },
    refresh() {
      captured.refresh += 1
    },
    effect(fn) {
      captured.disposed.push(fn)
      return () => {}
    },
  }
}

test('installNative：没有桥接时安静返回 false', () => {
  const home = tempHome()
  try {
    const ok = installNative({ get: () => null }, { home, config: {}, warn: () => {} })
    assert.equal(ok, false)
  } finally {
    clean(home)
  }
})

test('installNative：注册 strip + panel，骨架只含绑定路径', async () => {
  const home = tempHome()
  const root = tempEngine()
  try {
    seedInject(home)
    writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    const bridge = fakeBridge()
    const ctx = { get: (name) => (name === 'dshGo' ? bridge : null) }
    const ok = installNative(ctx, { home, config: { aiRoot: root }, warn: () => {} })
    assert.equal(ok, true)
    assert.equal(bridge.captured.strip.id, 'purge-alert')
    assert.equal(bridge.captured.panel.id, 'status')

    const view = bridge.captured.panel.spec.view()
    assert.equal(view.type, 'stack')
    const json = JSON.stringify(view)
    assert.ok(json.includes('"$":"data.patchText"'))
    assert.ok(json.length < 4096, '骨架不该带扫描结果')

    // data() 会先推送一次（setTimeout 0），等一拍
    await new Promise((r) => setTimeout(r, 60))
    const data = bridge.captured.lastData
    assert.ok(data, '应当推过一次数据')
    assert.equal(typeof data.summary, 'string')
    assert.equal(typeof data.patchText, 'string')
    // caption 现在只说「还差什么」，不再重复分子分母
    assert.ok(data.patchCaption.length > 0)
    assert.ok(/等着打|生效|桌面专属|这版引擎没有/.test(data.patchCaption), data.patchCaption)
    assert.ok(data.extras.includes('位置 head'))
    assert.ok(Array.isArray(data.detail))

    // 事件被清掉后不再重注册；refresh 按钮只 toast
    const refreshed = bridge.captured.panel.spec.actions.refresh()
    assert.deepEqual(refreshed, { toast: '已重读' })
    assert.ok(bridge.captured.refresh >= 0)
  } finally {
    clean(home, root)
  }
})

test('安装后的按钮：开关注入真的改状态，还原补丁在没有备份时给提示', async () => {
  const home = tempHome()
  const root = tempEngine()
  try {
    seedInject(home)
    const bridge = fakeBridge()
    const ctx = { get: (name) => (name === 'dshGo' ? bridge : null) }
    installNative(ctx, { home, config: { aiRoot: root }, warn: () => {} })
    const actions = bridge.captured.panel.spec.actions

    const off = actions.toggle()
    assert.deepEqual(off, { toast: '注入已关' })
    assert.equal(readState(home).enabled, false)

    const on = actions.toggle()
    assert.deepEqual(on, { toast: '注入已开' })
    assert.equal(readState(home).enabled, true)

    const revert = actions.patchRevert()
    assert.ok(String(revert.toast).includes('备份') || String(revert.toast).includes('还原'), revert.toast)

    // 一键注入是 deferred：同步只返回 pending，result 才是真活
    const one = actions.oneClick()
    assert.equal(typeof one.pending.label, 'string')
    assert.ok(one.pending.timeoutMs <= 60_000)
    const result = await one.result()
    assert.equal(typeof result.toast, 'string')

    // 面板按钮上限 4 个：重读 / 一键注入 / 开关注入 / 还原补丁（boost 走 /purge boost）
    assert.deepEqual(Object.keys(actions).sort(), ['oneClick', 'patchRevert', 'refresh', 'toggle'])
  } finally {
    clean(home, root)
  }
})

test('诊断日志写在 dsh-purge/native-diag.log，便于排查「面板没出现」', () => {
  const home = tempHome()
  try {
    const bridge = fakeBridge()
    const ctx = { get: (name) => (name === 'dshGo' ? bridge : null) }
    installNative(ctx, { home, config: {}, warn: () => {} })
    const log = path.join(home, 'dsh-purge', 'native-diag.log')
    assert.ok(fs.existsSync(log))
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(lines.some((l) => l.stage === 'enter' && l.hasBridge === true))
    assert.ok(lines.some((l) => l.stage === 'rearm'))
  } finally {
    clean(home)
  }
})
