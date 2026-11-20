// 包清单与 dsh-go 原生界面的接线：这些字段写错，App 里就是「没有胶囊、没有面板」。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const plugin = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

test('包名与导出入口', () => {
  assert.equal(pkg.name, 'dsh-purge-community-go')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(plugin.name, 'dsh-purge-community-go')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['systemPrompt', 'tools'])
})

test('dsh-go 原生清单：胶囊 / 面板 / 状态条都在', () => {
  const go = pkg.dshGo
  assert.equal(go.v, 1)
  assert.equal(go.title.zh, '破甲')
  const actions = go.contributes['composer.actions']
  assert.equal(actions.length, 1)
  assert.equal(actions[0].id, 'purge-status')
  assert.deepEqual(actions[0].effect, { type: 'open', page: 'panel:status' })
  const panels = go.contributes.panels
  assert.equal(panels.length, 1)
  assert.equal(panels[0].id, 'status')
  // 三个挂载点：对话页签、聊天侧栏、功能页
  assert.deepEqual(panels[0].placement, ['session.tab', 'chat.panel', 'features'])
  const strip = go.contributes['composer.strip']
  assert.equal(strip.length, 1)
  assert.equal(strip[0].panel, 'status')
})

test('cordis 补丁插入项与包名一致', () => {
  const text = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(text, /- insert:/)
  assert.match(text, /id: dsh-purge-community-go/)
  assert.match(text, /name: dsh-purge-community-go/)
})

test('包内文件都在（入口、补丁表、加密正文、分类表、脚本）', () => {
  for (const rel of [
    'lib/index.js',
    'lib/view.js',
    'lib/dshgo.js',
    'lib/prompt.js',
    'lib/table-read.js',
    'lib/asset-table.json',
    'patches/patches.json',
    'patches/purge-patch.mjs',
    'patches/lib/core.mjs',
    'assets/categories.json',
    'scripts/export-community-patches.mjs',
    'scripts/reseal-prompt.mjs',
    'install.sh',
    'LICENSE',
    'LICENSE-community',
    'NOTICE',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `缺少 ${rel}`)
  }
})

test('engines 边界与 dsh-go 手机端一致', () => {
  assert.equal(pkg.engines.dsh, '>=0.2.1-rc.2 <0.3.0-0')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})
