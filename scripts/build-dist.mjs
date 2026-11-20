#!/usr/bin/env node
/**
 * 构建发布产物：dist/<name>-<version>.tar.gz、.zip、SHA256SUMS、manifest.json、RELEASE_NOTES.md。
 *
 *   node scripts/build-dist.mjs [--no-verify]
 *
 * 为什么要产物：手机端拿到的是一个可解包的目录（用 git 拉也行，但 release 包更省事，
 * 而且带 SHA256SUMS 能核对有没有传坏）。
 *
 * 实现说明：
 *   - 打包用系统 tar（Linux / macOS / Windows 10+ / proot 都有）；zip 在有 zip 命令时顺手产出，
 *     Windows 上退回 PowerShell 的 Compress-Archive，都没有就只出 tar.gz，不报错。
 *   - 打完立刻解包到临时目录校验关键文件，避免打出一个空壳还上传。
 *   - 全部用 spawnSync + stdio:'ignore'：某些受限环境不允许管道捕获子进程输出。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.dirname(HERE)
/** 打包必须在仓库的上一级执行：归档里要带顶层目录 dsh-purge-community-go/。 */
const PARENT = path.dirname(PKG_DIR)
const OUT_DIR = path.join(PKG_DIR, 'dist')

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
const NAME = pkg.name
const VERSION = pkg.version
const BASE = `${NAME}-${VERSION}`

const EXCLUDES = ['.git', 'node_modules', 'dist', 'patch-probe.json', '*.log', '.DS_Store', 'backup-*']

/** 关键文件：缺任何一个都说明产物是空壳。 */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'install.sh',
  'lib/index.js',
  'lib/asset-table.json',
  'patches/patches.json',
  'patches/purge-patch.mjs',
  'patches/lib/core.mjs',
  'README.md',
  'README.en.md',
  'LICENSE',
  'LICENSE-community',
  'NOTICE',
]

function run(cmd, args, cwd = PARENT) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'ignore' })
  return result.status === 0
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walk(dir, base = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? path.join(base, entry.name) : entry.name
    if (entry.isDirectory()) out.push(...walk(dir, rel))
    else out.push(rel)
  }
  return out
}

function main() {
  const noVerify = process.argv.includes('--no-verify')

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  // ── tar.gz ──────────────────────────────────────────────────────────
  const tarball = path.join(OUT_DIR, `${BASE}.tar.gz`)
  const tarArgs = ['-czf', tarball]
  for (const pattern of EXCLUDES) tarArgs.push(`--exclude=${pattern}`)
  tarArgs.push(NAME)
  if (!run('tar', tarArgs)) {
    console.error('✖ tar 打包失败（找不到 tar 或权限不足）')
    process.exit(1)
  }
  console.log(`✔ ${path.relative(PKG_DIR, tarball)}  ${(fs.statSync(tarball).size / 1024).toFixed(1)} KB`)

  // ── zip（可选）─────────────────────────────────────────────────────
  // 三种实现按可用性依次尝试：bsdtar -a（Windows 自带 tar 就能出 zip，且支持 --exclude）、
  // GNU zip 命令（CI 上一般都有）、PowerShell Compress-Archive（兜底，但不支持排除规则）。
  const zipFile = path.join(OUT_DIR, `${BASE}.zip`)
  const bsdtarArgs = ['-a', '-cf', zipFile]
  for (const pattern of EXCLUDES) bsdtarArgs.push(`--exclude=${pattern}`)
  bsdtarArgs.push(NAME)
  let zipped = run('tar', bsdtarArgs)
  if (!zipped) {
    const zipArgs = ['-qr', zipFile, NAME]
    for (const pattern of EXCLUDES) zipArgs.push('-x', `${NAME}/${pattern}`)
    zipped = run('zip', zipArgs)
  }
  if (!zipped && process.platform === 'win32') {
    zipped = run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${PKG_DIR}\\${NAME}' -DestinationPath '${zipFile}' -Force`,
    ])
  }
  if (zipped) console.log(`✔ ${path.relative(PKG_DIR, zipFile)}  ${(fs.statSync(zipFile).size / 1024).toFixed(1)} KB`)
  else console.log('· 跳过 zip（本机没有可用的 zip 实现），tar.gz 已足够')

  // ── 校验：解包到临时目录，核对关键文件 ───────────────────────────────
  if (!noVerify) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-verify-'))
    const ok = run('tar', ['-xzf', tarball, '-C', tmp])
    if (!ok) {
      console.error('✖ 产物解包失败，不能发布')
      process.exit(1)
    }
    const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(tmp, NAME, rel)))
    const extracted = JSON.parse(fs.readFileSync(path.join(tmp, NAME, 'package.json'), 'utf8'))
    fs.rmSync(tmp, { recursive: true, force: true })
    if (missing.length) {
      console.error(`✖ 产物缺文件：${missing.join(', ')}`)
      process.exit(1)
    }
    if (extracted.version !== VERSION) {
      console.error(`✖ 产物里的版本 ${extracted.version} 与 package.json ${VERSION} 不一致`)
      process.exit(1)
    }
    console.log(`✔ 解包校验通过（${REQUIRED.length} 个关键文件齐全，版本 ${VERSION}）`)
  }

  // ── 清单 ────────────────────────────────────────────────────────────
  const files = walk(PKG_DIR)
    .filter((rel) => !rel.startsWith('dist' + path.sep) && !rel.startsWith('node_modules'))
    .filter((rel) => !rel.startsWith('.git' + path.sep))
    .sort()
  const manifest = {
    name: NAME,
    version: VERSION,
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    artifacts: [{ file: path.basename(tarball), bytes: fs.statSync(tarball).size, sha256: sha256(tarball) }],
    files: files.map((rel) => ({
      path: rel.split(path.sep).join('/'),
      bytes: fs.statSync(path.join(PKG_DIR, rel)).size,
      sha256: sha256(path.join(PKG_DIR, rel)),
    })),
  }
  if (zipped) manifest.artifacts.push({ file: path.basename(zipFile), bytes: fs.statSync(zipFile).size, sha256: sha256(zipFile) })
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const sums = manifest.artifacts.map((a) => `${a.sha256}  ${a.file}`).join('\n') + '\n'
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS'), sums, 'utf8')
  console.log('✔ dist/manifest.json  dist/SHA256SUMS')

  // ── 发布说明（Release 正文 / 仓库里也能直接看）───────────────────────
  const notes = buildNotes(manifest)
  fs.writeFileSync(path.join(OUT_DIR, 'RELEASE_NOTES.md'), notes, 'utf8')
  console.log('✔ dist/RELEASE_NOTES.md')
}

function buildNotes(manifest) {
  const artifactRows = manifest.artifacts
    .map((a) => `| \`${a.file}\` | ${(a.bytes / 1024).toFixed(1)} KB | \`${a.sha256}\` |`)
    .join('\n')
  return `# ${NAME} v${VERSION}

把 **dsh-purge-community**（社区维护版破甲）搬成 **dsh-go** 手机端原生插件：
内容用社区版（88 条补丁表 + 注入正文 + boost / 探针 / 注入位置 / 题材分类），
形态用 dsh-go（原生胶囊 / 面板 / 状态条、组装 waterfall、事务式补丁执行器）。

## 构建产物

| 文件 | 大小 | SHA-256 |
|---|---|---|
${artifactRows}

构建时间：${manifest.builtAt} · Node ${manifest.node} · ${manifest.platform}

## 手机安装（Android + proot）

\`\`\`sh
mkdir -p ~/src && cd ~/src
curl -L -o pg.tar.gz https://github.com/jick-nice/${NAME}/releases/download/v${VERSION}/${NAME}-${VERSION}.tar.gz
tar -xzf pg.tar.gz && mv ${NAME} ~/ && cd ~/${NAME}

sh install.sh --dry     # 只扫不打
sh install.sh           # 补丁 -> 原生界面目录 -> 插件
am force-stop io.github.ccch1mneyyy.dsh_app   # 重启引擎
\`\`\`

装完点输入框上方的「破甲状态」胶囊；要证明注入到达模型，敲 \`/purge probe\` 并让模型回显 nonce。

## 校验

\`\`\`sh
sha256sum ${NAME}-${VERSION}.tar.gz    # 与上表对应
\`\`\`

## 内容

- 补丁表来自 dsh-purge-community 1.7.20（MIT），导出为 \`patches/patches.json\`（88 条 + fileTargets）
- 注入正文与社区版同一份明文，用本包自己的盐重新封装（AES-256-GCM + deflate）
- 桌面专属能力（Electron / asar / 计划任务 / 更新器 / 红队演练台）未移植，理由见 docs/port-notes.md

许可：本包 AGPL-3.0；补丁表与正文 MIT（见 NOTICE 与 LICENSE-community）。
`
}

main()
