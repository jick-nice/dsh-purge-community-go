// 补丁表本身：88 条、id 唯一、每个文件键都能落到「包名 + 相对路径」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTable, targetsFor, editsOf, isRegexEdit, isDesktopOnly } from '../patches/lib/core.mjs'

const table = loadTable()

test('表里有 88 条补丁，id 唯一', () => {
  assert.equal(table.patches.length, 88)
  const ids = table.patches.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every((id) => Number.isInteger(id) && id > 0))
})

test('元信息记录了来源，用得上时能显示', () => {
  assert.equal(table.meta.source, 'dsh-purge-community')
  assert.ok(table.meta.exportedAt)
})

test('每个文件键都能解析成包名 + 相对路径', () => {
  for (const p of table.patches) {
    const keys = Array.isArray(p.file) ? p.file : [p.file]
    for (const key of keys) {
      assert.ok(key, `补丁 ${p.id} 有空文件键`)
      // 只有第三方/用户目录那几条是空列表（手机端必然 no_pkg），其余必须能解析
      const list = table.fileTargets[key]
      assert.ok(Array.isArray(list), `补丁 ${p.id} 的文件键 ${key} 没有映射`)
      if (list.length) {
        for (const entry of list) {
          assert.equal(typeof entry.pkg, 'string')
          assert.ok(Array.isArray(entry.rel) && entry.rel.length > 0, `${key} 的相对路径为空`)
        }
      }
    }
  }
})

test('每条补丁都有可执行的 replacement', () => {
  for (const p of table.patches) {
    assert.ok(editsOf(p).length > 0, `补丁 ${p.id} 没有可执行 edit`)
  }
})

test('正则形态的 pattern 序列化成 {source, flags} 并能还原', () => {
  const withRegex = table.patches.filter((p) => (p.replacements || []).some((r) => typeof r.pattern === 'object'))
  assert.ok(withRegex.length >= 5, `正则补丁太少：${withRegex.length}`)
  for (const p of withRegex) {
    for (const e of editsOf(p)) {
      if (!isRegexEdit(e)) continue
      assert.equal(typeof e.re.source, 'string')
      assert.ok(e.re.source.length > 0)
      // 数据里 flags 原样带过来（有的只有 i）；计数时会补 g，构造必须成立。
      assert.equal(typeof e.re.flags, 'string')
      const flags = e.re.flags.includes('g') ? e.re.flags : `${e.re.flags}g`
      assert.doesNotThrow(() => new RegExp(e.re.source, flags))
    }
  }
})

test('targetsFor：优先用 patch.rel，其次用表里的相对路径', () => {
  const patch = table.patches.find((p) => p.name === 'SANDBOX_POLICY_BRAND_NEUTRAL')
  const targets = targetsFor(patch, table)
  assert.deepEqual(targets, [{ pkg: 'dsh-sandbox-policy', rel: ['lib', 'index.js'] }])
})

test('targetsFor：表里没有的键退化成 dsh-<key>', () => {
  const targets = targetsFor({ id: 999, name: 'X', file: ['mystery-pkg'] }, { fileTargets: {} })
  assert.ok(targets.some((t) => t.pkg === 'dsh-mystery-pkg'))
})

test('桌面专属标记只认 surfaces:["desktop"]', () => {
  const desk = table.patches.filter(isDesktopOnly)
  assert.equal(desk.length, 7)
  assert.ok(desk.every((p) => p.surfaces.includes('desktop')))
})

test('opt-in 补丁只有两条（默认不打）', () => {
  const optIn = table.patches.filter((p) => p.optIn)
  assert.deepEqual(optIn.map((p) => p.id).sort((a, b) => a - b), [18, 19])
})
