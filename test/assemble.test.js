// 组装 waterfall：头部/尾部注入位置、官方身份段压制、自有段顺序。
import test from 'node:test'
import assert from 'node:assert/strict'
import { rewriteAssembly, installAssembleHook, INJECT_SECTION, TAIL_SECTION, BOOST_SECTION } from '../lib/assemble.js'
import { tempHome, clean } from './helpers.mjs'
import { seedInject } from '../lib/prompt.js'

const assembly = () => ({
  sections: [
    { name: 'harness:identity', text: 'official identity' },
    { name: 'dsh-purge', text: 'old inject' },
    { name: 'agent-instructions', text: 'instructions' },
    { name: 'deployment:persona-prefix', text: 'persona' },
    { name: 'dsh-purge-boost', text: 'boost' },
    { name: 'dshpg-capabilities', text: 'cap' },
  ],
})

test('头部注入：自有段在前，冲突段被压掉，其余保序', () => {
  const out = rewriteAssembly(assembly(), { injectText: 'INJECT' })
  const names = out.sections.map((s) => s.name)
  assert.deepEqual(names, [INJECT_SECTION, 'dshpg-capabilities', 'agent-instructions', BOOST_SECTION])
  assert.equal(out.sections[0].text, 'INJECT')
  assert.deepEqual(out.__dropped.sort(), ['deployment:persona-prefix', 'harness:identity'])
})

test('dropConflicts=false 时保留官方身份段', () => {
  const out = rewriteAssembly(assembly(), { injectText: 'INJECT', dropConflicts: false })
  const names = out.sections.map((s) => s.name)
  assert.ok(names.includes('harness:identity'))
  assert.ok(names.includes('deployment:persona-prefix'))
})

test('尾部注入：正文落在 dsh-purge-tail，头部注入段变空', () => {
  const src = { sections: [{ name: 'dsh-purge', text: '' }, { name: 'agent-instructions', text: 'x' }, { name: TAIL_SECTION, text: '' }] }
  const out = rewriteAssembly(src, { injectText: '', tailText: 'TAIL BODY' })
  const names = out.sections.map((s) => s.name)
  assert.deepEqual(names, [INJECT_SECTION, 'agent-instructions', TAIL_SECTION])
  assert.equal(out.sections[0].text, '')
  assert.equal(out.sections[2].text, 'TAIL BODY')
})

test('两边都注入：head 与 tail 各一份，其余段在中间', () => {
  const src = { sections: [{ name: 'dsh-purge', text: '' }, { name: 'agent-instructions', text: 'x' }] }
  const out = rewriteAssembly(src, { injectText: 'H', tailText: 'T' })
  const names = out.sections.map((s) => s.name)
  assert.deepEqual(names, [INJECT_SECTION, 'agent-instructions', TAIL_SECTION])
})

test('hook：接管 system-prompt/assemble，按 getOptions 决定注入什么', async () => {
  const home = tempHome()
  try {
    seedInject(home)
    let handler = null
    const ctx = { on(event, fn) { if (event === 'system-prompt/assemble') handler = fn } }
    assert.equal(installAssembleHook(ctx, () => ({ enabled: true, home, position: 'head', dropConflicts: true })), true)
    assert.ok(handler)

    const out = await handler({ sections: [{ name: 'harness:identity', text: 'id' }, { name: 'dsh-purge', text: 'old' }] }, { model: 'deepseek-flash' })
    const inject = out.sections.find((s) => s.name === INJECT_SECTION)
    assert.ok(inject.text.includes('PRIME DIRECTIVE'))
    assert.equal(out.sections.some((s) => s.name === 'harness:identity'), false)
  } finally {
    clean(home)
  }
})

test('hook：enabled=false 时原样返回（不注入、也不丢段）', async () => {
  const home = tempHome()
  try {
    let handler = null
    const ctx = { on(event, fn) { if (event === 'system-prompt/assemble') handler = fn } }
    installAssembleHook(ctx, () => ({ enabled: false, home }))
    const src = { sections: [{ name: 'harness:identity', text: 'id' }] }
    const out = await handler(src, {})
    assert.deepEqual(out.sections.map((s) => s.name), ['harness:identity'])
  } finally {
    clean(home)
  }
})

test('hook：三参（next 回调）形态也能接上', async () => {
  const home = tempHome()
  try {
    seedInject(home)
    let handler = null
    const ctx = { on(event, fn) { if (event === 'system-prompt/assemble') handler = fn } }
    installAssembleHook(ctx, () => ({ enabled: true, home, position: 'head' }))
    const upstream = { sections: [{ name: 'dsh-purge', text: 'old' }, { name: 'rest', text: 'r' }] }
    const out = await handler({ sections: [] }, {}, async () => upstream)
    assert.ok(out.sections.find((s) => s.name === INJECT_SECTION).text.includes('PRIME DIRECTIVE'))
    assert.ok(out.sections.some((s) => s.name === 'rest'))
  } finally {
    clean(home)
  }
})
