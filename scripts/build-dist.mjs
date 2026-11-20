#!/usr/bin/env node
/**
 * 构建发布产物：dist/<name>-<version>.tar.gz、.zip、SHA256SUMS、manifest.json、RELEASE_NOTES.md。
 *
 *   node scripts/build-dist.mjs [--no-verify]
 *
 * 流程：先把要发布的文件按**白名单**复制到临时 stage 目录，再从 stage 打包。
 * 这样 `.git` / `dist` / `node_modules` / 日志天然进不去——用 --exclude/ -x 那种黑名单
 * 在 zip 上很容易失手（`-x dir` 只排除同名文件，不排除目录内容），曾经因此发出过一个
 * 1.3 MB 的「zip」。
 *
 * 其它约定：
 *   - tar 用系统 tar（Linux / macOS / Windows 10+ / proot 都有）。
 *   - zip 依次尝试：zip 命令 → bsdtar -a（Windows 自带 tar 就是 bsdtar）→ Compress-Archive，
 *     写完查 PK 魔数；GNU tar 的 -a 只是「按扩展名自动压缩」，会把 tar 流写成 .zip。
 *   - 打完解包回校验关键文件，避免把空壳发出去。
 *   - 子进程一律 spawnSync + stdio:'ignore'：受限环境不允许管道捕获输出。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.dirname(HERE)
const OUT_DIR = path.join(PKG_DIR, 'dist')

const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8'))
const NAME = pkg.name
const VERSION = pkg.version
const BASE = `${NAME}-${VERSION}`

/** 发布包内容白名单：只放运行与文档需要的，测试也带上（体积小，用户能自检）。 */
const INCLUDE = [
  'lib',
  'patches',
  'assets',
  'scripts',
  'docs',
  'test',
  'package.json',
  'cordis.patch.yml',
  'install.sh',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
  'LICENSE-community',
  'NOTICE',
]

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

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'ignore' })
  return result.status === 0
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 真的是 zip 吗？GNU tar 会把 .zip 写成 tar 流，光看退出码会当成功。 */
function isZip(file) {
  try {
    const sig = fs.readFileSync(file).subarray(0, 4).toString('hex')
    // 504b0304 普通 / 504b0506 空归档 / 504b0708 分卷
    return sig === '504b0304' || sig === '504b0506' || sig === '504b0708'
  } catch {
    return false
  }
}

/** 按白名单把包目录复制到 stage/<NAME>/。 */
function stagePackage(stageRoot) {
  const dest = path.join(stageRoot, NAME)
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of INCLUDE) {
    const from = path.join(PKG_DIR, entry)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(dest, entry), { recursive: true })
  }
  return dest
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

/** 压缩包里的文件清单（用于 manifest：记录真正发布出去的文件）。 */
function stagedFiles(stageRoot) {
  return walk(path.join(stageRoot, NAME))
    .map((rel) => rel.split(path.sep).join('/'))
    .sort()
}

function main() {
  const noVerify = process.argv.includes('--no-verify')

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-stage-'))
  stagePackage(stageRoot)

  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(stageRoot, NAME, rel)))
  if (missing.length) {
    fs.rmSync(stageRoot, { recursive: true, force: true })
    console.error(`✖ 待打包目录缺文件：${missing.join(', ')}（检查白名单 INCLUDE）`)
    process.exit(1)
  }

  // ── tar.gz ──────────────────────────────────────────────────────────
  const tarball = path.join(OUT_DIR, `${BASE}.tar.gz`)
  if (!run('tar', ['-czf', tarball, NAME], stageRoot)) {
    fs.rmSync(stageRoot, { recursive: true, force: true })
    console.error('✖ tar 打包失败（找不到 tar 或权限不足）')
    process.exit(1)
  }
  console.log(`✔ ${path.relative(PKG_DIR, tarball)}  ${(fs.statSync(tarball).size / 1024).toFixed(1)} KB`)

  // ── zip（可选）─────────────────────────────────────────────────────
  const zipFile = path.join(OUT_DIR, `${BASE}.zip`)
  const tryZipCommand = () => run('zip', ['-qr', zipFile, NAME], stageRoot) && isZip(zipFile)
  const tryBsdtarZip = () => run('tar', ['-a', '-cf', zipFile, NAME], stageRoot) && isZip(zipFile)
  const tryCompressArchive = () =>
    process.platform === 'win32' &&
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${path.join(stageRoot, NAME)}' -DestinationPath '${zipFile}' -Force`,
    ]) &&
    isZip(zipFile)

  const attempts = process.platform === 'win32'
    ? [tryBsdtarZip, tryCompressArchive, tryZipCommand]
    : [tryZipCommand, tryBsdtarZip, tryCompressArchive]
  let zipped = false
  for (const attempt of attempts) {
    if (attempt()) {
      zipped = true
      break
    }
    fs.rmSync(zipFile, { force: true })
  }
  if (zipped) console.log(`✔ ${path.relative(PKG_DIR, zipFile)}  ${(fs.statSync(zipFile).size / 1024).toFixed(1)} KB`)
  else console.log('· 跳过 zip（本机没有能产出合法 zip 的工具），tar.gz 已足够')

  // ── 校验：解包到另一个临时目录，核对关键文件与版本 ─────────────────
  if (!noVerify) {
    const verifyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-verify-'))
    const ok = run('tar', ['-xzf', tarball, '-C', verifyDir])
    if (!ok) {
      console.error('✖ 产物解包失败，不能发布')
      process.exit(1)
    }
    const verifyMissing = REQUIRED.filter((rel) => !fs.existsSync(path.join(verifyDir, NAME, rel)))
    const extracted = JSON.parse(fs.readFileSync(path.join(verifyDir, NAME, 'package.json'), 'utf8'))
    fs.rmSync(verifyDir, { recursive: true, force: true })
    if (verifyMissing.length) {
      console.error(`✖ 产物缺文件：${verifyMissing.join(', ')}`)
      process.exit(1)
    }
    if (extracted.version !== VERSION) {
      console.error(`✖ 产物里的版本 ${extracted.version} 与 package.json ${VERSION} 不一致`)
      process.exit(1)
    }
    console.log(`✔ 解包校验通过（${REQUIRED.length} 个关键文件齐全，版本 ${VERSION}）`)
  }

  // ── 清单 ────────────────────────────────────────────────────────────
  const files = stagedFiles(stageRoot)
  const manifest = {
    name: NAME,
    version: VERSION,
    builtAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    artifacts: [{ file: path.basename(tarball), bytes: fs.statSync(tarball).size, sha256: sha256(tarball) }],
    files: files.map((rel) => {
      const full = path.join(stageRoot, NAME, ...rel.split('/'))
      return { path: rel, bytes: fs.statSync(full).size, sha256: sha256(full) }
    }),
  }
  if (zipped) manifest.artifacts.push({ file: path.basename(zipFile), bytes: fs.statSync(zipFile).size, sha256: sha256(zipFile) })

  fs.rmSync(stageRoot, { recursive: true, force: true })

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const sums = manifest.artifacts.map((a) => `${a.sha256}  ${a.file}`).join('\n') + '\n'
  fs.writeFileSync(path.join(OUT_DIR, 'SHA256SUMS'), sums, 'utf8')
  console.log(`✔ dist/manifest.json（${files.length} 个文件）  dist/SHA256SUMS`)

  // ── 发布说明（Release 正文 / 仓库里也能直接看）───────────────────────
  fs.writeFileSync(path.join(OUT_DIR, 'RELEASE_NOTES.md'), buildNotes(manifest), 'utf8')
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
