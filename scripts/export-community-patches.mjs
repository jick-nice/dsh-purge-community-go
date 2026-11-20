#!/usr/bin/env node
/**
 * 把 dsh-purge-community 的补丁表导出成 patches/patches.json。
 *
 * 为什么要导出而不是直接 import community 的 lib/patches/*：
 *   1. community 的执行器是路径型的（targetFiles(aiBase) 返回绝对路径表），
 *      dsh-go 侧的引擎布局不同，得改成「包名 + 相对路径」解析；
 *   2. 补丁表里有 RegExp 形态的 pattern，JSON 化时退化成 {}，
 *      这里统一写成 { source, flags }，由 patches/lib/core.mjs 还原；
 *   3. 顺带把 community targetFiles() 里的「文件键 → 包名 + 相对路径」映射
 *      抽成静态表（fileTargets），执行器不再需要猜。
 *
 *   node scripts/export-community-patches.mjs \
 *        --community ../dsh-purge-community \
 *        --out patches/patches.json
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const communityDir = path.resolve(ROOT, arg('community', '../dsh-purge-community'))
const outFile = path.resolve(ROOT, arg('out', 'patches/patches.json'))

if (!fs.existsSync(path.join(communityDir, 'package.json'))) {
  console.error(`找不到社区版仓库：${communityDir}`)
  process.exit(1)
}

/** 社区版版本号：写进表头，面板上显示「表来自哪个版本」。 */
function communityVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(communityDir, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}

/** 补丁表：community 已经从 lib/core.js 拆到 lib/patches/*.mjs。 */
const indexFile = path.join(communityDir, 'lib', 'patches', 'index.mjs')
const { ALL_PATCHES, PATCH_DISPLAY_GROUPS } = await import(pathToFileURL(indexFile).href)

/** 一条 pattern 统一成 JSON 友好的形态。 */
function patternOf(p) {
  if (p instanceof RegExp) return { source: p.source, flags: p.flags }
  if (typeof p === 'string') return p
  if (p && typeof p.source === 'string') return { source: p.source, flags: typeof p.flags === 'string' ? p.flags : 'g' }
  return ''
}

function replacementsOf(patch) {
  const out = []
  for (const r of patch.replacements || []) {
    const pat = patternOf(r.pattern)
    if (!pat) continue
    out.push({ pattern: pat, replace: typeof r.replace === 'string' ? r.replace : '' })
  }
  if (Array.isArray(patch.patterns) && typeof patch.replace === 'string') {
    for (const s of patch.patterns) out.push({ pattern: patternOf(s), replace: patch.replace })
  }
  return out
}

/**
 * 从 community 的 targetFiles() 源码里抽出「文件键 → [{pkg, rel}]」。
 *
 * 只认两种写法（其余一律跳过，那些是 dshHome / 用户预设 / 第三方面，dsh-go 上没有）：
 *   path.join(aiBase, "dsh-xxx", "lib", "index.js")
 *   nestedPkg(aiBase, "dsh-xxx", "lib", "index.js")
 *
 * 结果不写死包名列表——同一个键可能对应多个包（nested / monorepo），全部保留。
 */
function fileTargetsFromCore() {
  const file = path.join(communityDir, 'lib', 'core.js')
  // 统一换行：仓库里两种都有（LF/CRLF），不归一化会让下面的定位与切块全落空。
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n')
  const start = text.indexOf('export function targetFiles(')
  const end = text.indexOf('return filterTargetFiles(files)', start)
  if (start < 0 || end < 0) throw new Error('在 community 的 core.js 里找不到 targetFiles()')
  const body = text.slice(start, end)

  const targets = {}
  // 按 `    "key": ` 切块（缩进 4 空格，值以 [ 开头）
  const keyRe = /^ {4}"([a-z0-9-]+)":/gm
  const marks = []
  let m
  while ((m = keyRe.exec(body))) marks.push({ key: m[1], at: m.index })
  marks.forEach((mark, i) => {
    const block = body.slice(mark.at, i + 1 < marks.length ? marks[i + 1].at : body.length)
    const list = []
    const joinRe = /path\.join\(\s*aiBase\s*,\s*"([^"]+)"((?:\s*,\s*"[^"]+")*)\)/g
    const nestedRe = /nestedPkg\(\s*aiBase\s*,\s*"([^"]+)"((?:\s*,\s*"[^"]+")*)\)/g
    for (const re of [joinRe, nestedRe]) {
      let j
      while ((j = re.exec(block))) {
        const pkg = j[1]
        const rest = [...j[2].matchAll(/"([^"]+)"/g)].map((x) => x[1])
        if (!rest.length) continue
        list.push({ pkg, rel: rest })
      }
    }
    if (list.length) targets[mark.key] = list
  })
  return targets
}

const fileTargets = fileTargetsFromCore()

/**
 * 源码里没法自动抽出来的那些键，按同样的布局规则补上。
 *
 * 这些键在 community 侧是「多个候选路径里挑第一个存在的」，其中一部分落在
 * $DSH_HOME 或别的地方；dsh-go 上对应的是下面这些（不存在就是 no_pkg / no_file，
 * 这正是我们想看到的结果，而不是猜错路径去打别人的文件）。
 */
const NESTED = (pkg, rel) => ({ pkg: 'dsh', rel: ['node_modules', '@deepseek-ai', pkg, ...rel] })
const PI_AI = (file) => ({ pkg: '../@earendil-works/pi-ai', rel: ['dist', 'api', file] })

const FALLBACK_TARGETS = {
  // 预设：web-app 包内 presets/ 或 agent-presets 包内 presets/<名>/
  'agent-preset': [
    { pkg: 'dsh-agent-presets', rel: ['presets', 'standard', 'agent.cordis.yml'] },
    { pkg: 'dsh-web-app', rel: ['presets', 'standard.patch.yml'] },
  ],
  'preset-standard': [
    { pkg: 'dsh-web-app', rel: ['presets', 'standard.patch.yml'] },
    { pkg: 'dsh-agent-presets', rel: ['presets', 'standard', 'agent.cordis.yml'] },
  ],
  'preset-ptc': [
    { pkg: 'dsh-web-app', rel: ['presets', 'ptc.patch.yml'] },
    { pkg: 'dsh-agent-presets', rel: ['presets', 'ptc', 'agent.cordis.yml'] },
  ],
  'preset-cordis': [
    { pkg: 'dsh-web-app', rel: ['presets', 'cordis.patch.yml'] },
    { pkg: 'dsh-agent-presets', rel: ['presets', 'cordis', 'agent.cordis.yml'] },
  ],
  'preset-minimal': [
    { pkg: 'dsh-web-app', rel: ['presets', 'minimal.patch.yml'] },
    { pkg: 'dsh-agent-presets', rel: ['presets', 'minimal', 'agent.cordis.yml'] },
  ],
  // unrestricted 只存在于用户目录（$DSH_HOME/.agent-presets/），引擎包里没有 —— 按包内登记，
  // 扫描结果是 no_pkg，面板上归到「桌面专属」，不参与手机适用条数。
  'preset-unrestricted': [
    { pkg: 'dsh-agent-presets', rel: ['presets', 'unrestricted', 'agent.cordis.yml'] },
  ],
  // 第三方预设包 / 用户目录：dsh-go 上本来就没有。
  'preset-liangshen': [],
  'preset-liangshen-pkg': [],
  'liangshen-tool-bootstrap': [],
  // Electron 主进程：手机没有这一层。
  'desktop-shell': [{ pkg: 'dsh-desktop-shell', rel: ['lib', 'index.js'] }],
  // npm 嵌套副本（@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>）
  'system-prompt-nested': [NESTED('dsh-system-prompt', ['lib', 'index.js'])],
  'tool-web-nested': [NESTED('dsh-tool-web', ['lib', 'index.js'])],
  'hooks-claude-code-nested': [NESTED('dsh-hooks-claude-code', ['lib', 'index.js'])],
  'hooks-codex-nested': [NESTED('dsh-hooks-codex', ['lib', 'index.js'])],
  // 别的模型后端（@deepseek-ai 同级目录）
  'pi-ai-anthropic-messages': [PI_AI('anthropic-messages.js')],
  'pi-ai-completions': [PI_AI('openai-completions.js')],
  'pi-ai-responses-shared': [PI_AI('openai-responses-shared.js')],
}

for (const [key, list] of Object.entries(FALLBACK_TARGETS)) {
  if (!fileTargets[key] || fileTargets[key].length === 0) fileTargets[key] = list
}

const exported = ALL_PATCHES.map((p) => {
  const files = Array.isArray(p.file) ? p.file : [p.file]
  const out = {
    id: p.id,
    name: p.name,
    layer: p.layer,
    layer_en: p.layer_en,
    desc: p.desc,
    file: files,
    replacements: replacementsOf(p),
  }
  if (Array.isArray(p.rel)) out.rel = p.rel
  else if (typeof p.rel === 'string') out.rel = p.rel.split('/').filter(Boolean)
  if (Array.isArray(p.markers) && p.markers.length) out.markers = p.markers
  if (typeof p.marker === 'string' && p.marker) out.marker = p.marker
  if (p.markersAny === true) out.markersAny = true
  if (typeof p.forbid === 'string') out.forbid = p.forbid
  else if (Array.isArray(p.forbid) && p.forbid.length) out.forbid = p.forbid
  if (p.optional === true) out.optional = true
  if (p.skipIfMarked === true) out.skipIfMarked = true
  if (p.surfaces) out.surfaces = p.surfaces
  if (p.optIn === true || p.disabledByDefault === true) out.optIn = true
  return out
})

const payload = {
  // 导出元信息：probe 面板上会显示「表来自哪个版本」，出错时一眼能对上。
  meta: {
    source: 'dsh-purge-community',
    version: communityVersion(),
    exportedAt: new Date().toISOString(),
    count: exported.length,
    displayGroups: PATCH_DISPLAY_GROUPS || {},
  },
  fileTargets,
  patches: exported,
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

const rel = path.relative(ROOT, outFile)
console.log(`已导出 ${exported.length} 条补丁 → ${rel}`)
console.log(`文件键映射 ${Object.keys(fileTargets).length} 个；字节 ${fs.statSync(outFile).size}`)
