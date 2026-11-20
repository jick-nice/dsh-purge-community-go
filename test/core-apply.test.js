// 补丁执行器：探测 / 事务式应用 / 还原 / opt-in 闸门 / 失败回滚。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  probe,
  apply,
  restore,
  tally,
  applicableOf,
  isDesktopOnly,
  editsOf,
  isDone,
} from '../patches/lib/core.mjs'
import { tempEngine, writePkgFile, read, clean, SANDBOX_POLICY_SOURCE } from './helpers.mjs'

const PATCH_93 = {
  id: 93,
  name: 'SANDBOX_POLICY_BRAND_NEUTRAL',
  file: ['sandbox-policy'],
  rel: ['lib', 'index.js'],
  replacements: [
    { pattern: 'Current DSH file policy: ', replace: 'Current file policy: ' },
    { pattern: 'enforced by the DSH file sandbox', replace: 'enforced by the file sandbox' },
    { pattern: 'The DSH file sandbox does not restrict', replace: 'The file sandbox does not restrict' },
  ],
  markers: ['Current file policy: '],
}
const TABLE_93 = {
  fileTargets: { 'sandbox-policy': [{ pkg: 'dsh-sandbox-policy', rel: ['lib', 'index.js'] }] },
  patches: [PATCH_93],
}

test('probe：目标文件里有 pattern = hit；打过 = applied', () => {
  const root = tempEngine()
  try {
    const file = writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    const before = probe(root, TABLE_93)
    assert.equal(before.length, 1)
    assert.equal(before[0].status, 'hit')
    assert.equal(before[0].hits, 3)
    assert.equal(before[0].total, 3)

    const report = apply(root, { table: TABLE_93, backupDir: path.join(root, 'backup-a') })
    assert.equal(report.applied, 1, report.logs.join('\n'))
    assert.ok(read(file).includes('Current file policy: '))

    const after = probe(root, TABLE_93)
    assert.equal(after[0].status, 'applied')
  } finally {
    clean(root)
  }
})

test('probe：包不在 = no_pkg，包在但文件不在 = no_file', () => {
  const root = tempEngine()
  try {
    const rows = probe(root, TABLE_93)
    assert.equal(rows[0].status, 'no_pkg')

    fs.mkdirSync(path.join(root, 'dsh-sandbox-policy', 'lib'), { recursive: true })
    const rows2 = probe(root, TABLE_93)
    assert.equal(rows2[0].status, 'no_file')
  } finally {
    clean(root)
  }
})

test('dry 只预演，不改文件也不建备份', () => {
  const root = tempEngine()
  try {
    const file = writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    const report = apply(root, { table: TABLE_93, dry: true, cwd: root })
    assert.equal(report.applied, 0)
    assert.equal(report.backupDir, null)
    assert.ok(report.logs.some((line) => line.startsWith('would edit')))
    assert.equal(read(file), SANDBOX_POLICY_SOURCE)
    assert.equal(fs.existsSync(path.join(root, 'files')), false)
  } finally {
    clean(root)
  }
})

test('restore 按备份还原，manifest 记录引擎版本与哈希', () => {
  const root = tempEngine()
  const backupDir = path.join(root, 'backup-restore')
  try {
    const file = writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    const report = apply(root, { table: TABLE_93, backupDir })
    assert.equal(report.applied, 1)
    const manifest = JSON.parse(read(path.join(backupDir, 'manifest.json')))
    assert.equal(manifest.engine.version, '0.2.2-rc.1')
    assert.equal(manifest.files.length, 1)

    const back = restore(backupDir, { root })
    assert.equal(back.restored, 1, back.logs.join('\n'))
    assert.equal(read(file), SANDBOX_POLICY_SOURCE)
  } finally {
    clean(root)
  }
})

test('引擎版本不一致时拒绝还原（App 更新后的旧备份）', () => {
  const root = tempEngine()
  const backupDir = path.join(root, 'backup-old')
  try {
    writePkgFile(root, 'dsh-sandbox-policy', ['lib', 'index.js'], SANDBOX_POLICY_SOURCE)
    apply(root, { table: TABLE_93, backupDir })
    const manifestFile = path.join(backupDir, 'manifest.json')
    const manifest = JSON.parse(read(manifestFile))
    manifest.engine = { version: '0.2.1-rc.1' }
    fs.writeFileSync(manifestFile, JSON.stringify(manifest))

    const back = restore(backupDir, { root })
    assert.equal(back.restored, 0)
    assert.equal(back.engineMismatch, true)
    assert.ok(back.errors.length > 0)
  } finally {
    clean(root)
  }
})

test('opt-in 补丁默认不打，列进 extraIds 才打', () => {
  const root = tempEngine()
  const patch = {
    id: 18,
    name: 'REPEAT_TOOL_REMINDER_DISABLED',
    file: ['repeat-tool-reminder'],
    replacements: [{ pattern: 'const LIMIT = 3', replace: 'const LIMIT = 99 /* [dsh-purge] disabled */' }],
    markers: ['[dsh-purge] disabled'],
    optIn: true,
  }
  const table = {
    fileTargets: { 'repeat-tool-reminder': [{ pkg: 'dsh-repeat-tool-reminder', rel: ['lib', 'index.js'] }] },
    patches: [patch],
  }
  try {
    const file = writePkgFile(root, 'dsh-repeat-tool-reminder', ['lib', 'index.js'], 'const LIMIT = 3\n')
    const skipped = apply(root, { table, backupDir: path.join(root, 'b1') })
    assert.equal(skipped.applied, 0)
    assert.ok(skipped.logs.some((line) => line.includes('opt-in')), skipped.logs.join('\n'))
    assert.ok(read(file).includes('const LIMIT = 3'))

    const done = apply(root, { table, extraIds: [18], backupDir: path.join(root, 'b2') })
    assert.equal(done.applied, 1, done.logs.join('\n'))
    assert.ok(read(file).includes('const LIMIT = 99'))
  } finally {
    clean(root)
  }
})

test('校验失败 → 整批回滚，文件保持原样', () => {
  const root = tempEngine()
  // 用 .json 做目标：JSON.parse 不依赖子进程，任何环境都能稳定复现「校验不通过」。
  const patch = {
    id: 900,
    name: 'BREAK_THE_JSON',
    file: ['broken-pkg'],
    replacements: [{ pattern: '"version": "1.0.0"', replace: '"version": ' }],
    markers: ['"version": '],
  }
  const table = {
    fileTargets: { 'broken-pkg': [{ pkg: 'dsh-broken-pkg', rel: ['package.json'] }] },
    patches: [patch],
  }
  const source = '{\n  "name": "dsh-broken-pkg",\n  "version": "1.0.0"\n}\n'
  try {
    const file = writePkgFile(root, 'dsh-broken-pkg', ['package.json'], source)
    const report = apply(root, { table, backupDir: path.join(root, 'b3') })
    assert.equal(report.rolledBack, true)
    assert.equal(report.failed, 1)
    assert.equal(report.applied, 0)
    assert.equal(read(file), source)
  } finally {
    clean(root)
  }
})

test('tally / applicableOf：桌面专属与 no_pkg 不计入手机适用条数', () => {
  const rows = [
    { id: 1, status: 'applied' },
    { id: 2, status: 'no_pkg' },
    { id: 45, status: 'applied', desktopOnly: true },
    { id: 3, status: 'hit' },
  ]
  assert.equal(applicableOf(rows), 2)
  assert.deepEqual(tally(rows), { applied: 2, no_pkg: 1, hit: 1 })
  assert.equal(isDesktopOnly({ surfaces: ['desktop'] }), true)
  assert.equal(isDesktopOnly({}), false)
})

test('追加型补丁不会重复追加（isDone 看完整 rep）', () => {
  const e = { pat: 'A', rep: 'A + B' }
  assert.equal(isDone(e, 'A'), false)
  assert.equal(isDone(e, 'A + B'), true)
  assert.equal(editsOf({ replacements: [{ pattern: 'x', replace: 'y' }] }).length, 1)
})
