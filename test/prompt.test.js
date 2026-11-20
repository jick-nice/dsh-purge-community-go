// 注入正文：加密正文能解、落盘不覆盖用户正文、变体与按模型指定的优先级。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openSlot } from '../lib/table-read.js'
import {
  defaultPromptText,
  normalizeText,
  sanitizeName,
  resolveInject,
  seedInject,
  writeInject,
  escapeInterpolation,
  listVariants,
  writeVariant,
  DEFAULT_VARIANT,
} from '../lib/prompt.js'
import { injectPath } from '../lib/home.js'
import { tempHome, clean } from './helpers.mjs'

test('加密正文能解开，且是 community 的那份', () => {
  const sealed = openSlot()
  assert.ok(sealed.length > 20_000, `正文太短：${sealed.length}`)
  assert.ok(sealed.includes('<|im_start|>'))
  assert.ok(sealed.includes('<project_instructions>'))
  assert.ok(sealed.includes('PRIME DIRECTIVE'))
  assert.ok(sealed.includes('Scoped Rules'))
  assert.equal(defaultPromptText(), sealed)
})

test('正文上线前就规整过：无 BOM、LF 换行、无 CR', () => {
  const text = normalizeText(defaultPromptText())
  assert.equal(text.charCodeAt(0) === 0xfeff, false)
  assert.equal(text.includes('\r'), false)
})

test('首次启动落盘，第二次不覆盖用户正文', () => {
  const home = tempHome()
  try {
    const first = seedInject(home)
    assert.equal(first.written, true)
    assert.ok(fs.existsSync(injectPath(home)))

    writeInject(home, 'USER CUSTOM BODY')
    const second = seedInject(home)
    assert.equal(second.written, false)
    assert.equal(fs.readFileSync(injectPath(home), 'utf8').trim(), 'USER CUSTOM BODY')

    const forced = seedInject(home, { force: true })
    assert.equal(forced.written, true)
    assert.ok(fs.readFileSync(injectPath(home), 'utf8').includes('PRIME DIRECTIVE'))
  } finally {
    clean(home)
  }
})

test('解析优先级：按模型变体 > 当前变体 > prompt-inject.md > 包内正文', () => {
  const home = tempHome()
  try {
    // 只有包内正文
    let out = resolveInject(home, { state: {} })
    assert.equal(out.source, 'builtin')
    assert.ok(out.bytes > 20_000)

    // 有 prompt-inject.md
    writeInject(home, 'FROM FILE')
    out = resolveInject(home, { state: {} })
    assert.equal(out.source, 'prompt-inject.md')
    assert.equal(out.text, 'FROM FILE')

    // 当前变体优先
    writeVariant(home, 'alt', 'FROM VARIANT')
    out = resolveInject(home, { state: { variant: 'alt' } })
    assert.equal(out.source, 'variant')
    assert.equal(out.variant, 'alt')

    // 按模型指定最优先
    writeVariant(home, 'bymodel', 'FROM MODEL VARIANT')
    out = resolveInject(home, { state: { variant: 'alt', byModel: { 'deepseek-flash': 'bymodel' } }, model: 'deepseek-flash' })
    assert.equal(out.source, 'variant:model')
    assert.equal(out.variant, 'bymodel')
    assert.equal(out.text, 'FROM MODEL VARIANT')

    // 变体列表
    assert.deepEqual(listVariants(home).map((v) => v.name).sort(), ['alt', 'bymodel'])
    assert.equal(sanitizeName(DEFAULT_VARIANT), 'default')
    assert.equal(sanitizeName('vendor/model:free'), 'vendor_model_free')
  } finally {
    clean(home)
  }
})

test('maxBytes 截断会标记 truncated', () => {
  const home = tempHome()
  try {
    writeInject(home, 'x'.repeat(500))
    const out = resolveInject(home, { state: {}, maxBytes: 100 })
    assert.equal(out.truncated, true)
    assert.equal(out.bytes, 100)
  } finally {
    clean(home)
  }
})

test('只保留 cwd / model / provider 三种插值，其余拆开', () => {
  const text = escapeInterpolation('a {{cwd}} b {{model}} c {{provider}} d {{secret}} e')
  assert.equal(text, 'a {{cwd}} b {{model}} c {{provider}} d { {secret}} e')
})

test('变体文件写在 dsh-purge/prompts 下，且规整换行', () => {
  const home = tempHome()
  try {
    const file = writeVariant(home, 'My Variant', 'line1\r\n\r\n\r\nline2  \r\n')
    assert.ok(file.endsWith(path.join('dsh-purge', 'prompts', 'my_variant.md')))
    assert.equal(fs.readFileSync(file, 'utf8'), 'line1\n\nline2\n')
  } finally {
    clean(home)
  }
})
