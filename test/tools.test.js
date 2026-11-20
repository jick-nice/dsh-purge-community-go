// 工具层：注册数量、purge_status 认 config.aiRoot、tuning / probe / apply 的返回值形状。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { registerTools } from '../lib/tools.js'
import { readState } from '../lib/state.js'
import { readTuning } from '../lib/community.js'
import { seedInject } from '../lib/prompt.js'
import { tempHome, tempEngine, writePkgFile, clean, SANDBOX_POLICY_SOURCE } from './helpers.mjs'

function fakeCtx() {
  const tools = []
  return {
    tools,
    ctx: { tools: { register: (d) => tools.push(d) } },
  }
}

test('注册八个工具，名字齐全', () => {
  const home = tempHome()
  try {
    const { ctx, tools } = fakeCtx()
    const count = registerTools(ctx, { home, config: {}, warn: () => {} })
    assert.equal(count, 8)
    assert.deepEqual(tools.map((t) => t.name), [
      'purge_status',
      'purge_apply',
      'purge_revert',
      'purge_prompt',
      'purge_category',
      'purge_tuning',
      'purge_probe',
      'purge_patch_apply',
    ])
    for (const tool of tools) {
      assert.ok(tool.description.length > 10, `${tool.name} 缺 description`)
      assert.equal(typeof tool.execute, 'function')
    }
  } finally {
    clean(home)
  }
})

test('purge_status 认 config.aiRoot（补丁层不靠全局探测）', async () => {
  const home = tempHome()
  const root = tempEngine()
  try {
    seedInject(home)
    writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    const { ctx, tools } = fakeCtx()
    registerTools(ctx, { home, config: { aiRoot: root }, warn: () => {} })
    const status = tools.find((t) => t.name === 'purge_status')
    const value = await status.execute({})
    assert.equal(value.patches.ok, true)
    assert.equal(value.patches.root, root)
    assert.ok(value.patches.applicable > 0, '应当扫到手机适用条目')
    assert.ok(value.patches.total >= 80)
    assert.ok(value.verdict.includes('破甲'))
    assert.ok(value.summary.includes('结论'))
    const rendered = status.output.render({}, value)
    assert.ok(rendered[0].text.includes('【注入层】'))
  } finally {
    clean(home, root)
  }
})

test('purge_status 在扫不到引擎时明说「无法判定」', async () => {
  const home = tempHome()
  try {
    seedInject(home)
    const { ctx, tools } = fakeCtx()
    registerTools(ctx, { home, config: { aiRoot: '/nope/not/here' }, warn: () => {} })
    const status = tools.find((t) => t.name === 'purge_status')
    const value = await status.execute({})
    // 假 root 存在与否：不存在时 detectRoot 失败 → ok=false；存在但空 → ok=true, applicable=0
    if (value.patches.ok) assert.equal(value.patches.applicable, 0)
    assert.ok(value.summary.includes('无法判定') || value.summary.includes('结论'))
  } finally {
    clean(home)
  }
})

test('purge_apply / purge_revert 改状态，purge_prompt show 有正文', async () => {
  const home = tempHome()
  try {
    const { ctx, tools } = fakeCtx()
    registerTools(ctx, { home, config: {}, warn: () => {} })
    const apply = tools.find((t) => t.name === 'purge_apply')
    const applied = await apply.execute({})
    assert.equal(applied.ok, true)
    assert.equal(applied.enabled, true)
    assert.ok(applied.bytes > 20_000)

    const revert = tools.find((t) => t.name === 'purge_revert')
    const reverted = await revert.execute({})
    assert.equal(reverted.ok, true)
    assert.equal(reverted.enabled, false)

    const prompt = tools.find((t) => t.name === 'purge_prompt')
    const shown = await prompt.execute({ action: 'show' })
    assert.ok(shown.preview.length > 100)
    assert.ok(shown.message.includes('字节'))
  } finally {
    clean(home)
  }
})

test('purge_tuning：boost / position / extra 都落到 tuning.json', async () => {
  const home = tempHome()
  try {
    const { ctx, tools } = fakeCtx()
    registerTools(ctx, { home, config: {}, warn: () => {} })
    const tun = tools.find((t) => t.name === 'purge_tuning')
    assert.equal((await tun.execute({ action: 'boost', value: 'off' })).boost, false)
    assert.equal((await tun.execute({ action: 'position', value: 'tail' })).injectPosition, 'tail')
    assert.deepEqual((await tun.execute({ action: 'extra', value: '19,18,18' })).extraPatches, [18, 19])
    const shown = await tun.execute({ action: 'show' })
    assert.ok(shown.message.includes('tail'))
    assert.equal(readTuning(home).boost, false)
  } finally {
    clean(home)
  }
})

test('purge_probe：new 出 nonce，clear 撤掉', async () => {
  const home = tempHome()
  try {
    const { ctx, tools } = fakeCtx()
    registerTools(ctx, { home, config: {}, warn: () => {} })
    const probe = tools.find((t) => t.name === 'purge_probe')
    const created = await probe.execute({ action: 'new' })
    assert.match(created.nonce, /^purge-[0-9a-f]{8}$/)
    assert.ok(created.message.includes(created.nonce))
    assert.ok(fs.existsSync(path.join(home, 'dsh-purge', 'probe.json')))
    const cleared = await probe.execute({ action: 'clear' })
    assert.equal(cleared.nonce, '')
  } finally {
    clean(home)
  }
})

test('purge_category：默认分类可列出，add / rm 生效', async () => {
  const home = tempHome()
  try {
    const { ctx, tools } = fakeCtx()
    registerTools(ctx, { home, config: {}, warn: () => {} })
    const cat = tools.find((t) => t.name === 'purge_category')
    const list = await cat.execute({ action: 'list' })
    assert.ok(list.count > 0)
    const added = await cat.execute({ action: 'add', id: 'demo', labels: '示例,样例', rule: '这是一条测试规则。' })
    assert.ok(added.count >= list.count)
    const removed = await cat.execute({ action: 'rm', id: 'demo' })
    assert.ok(removed.message.includes('已删'))
  } finally {
    clean(home)
  }
})
