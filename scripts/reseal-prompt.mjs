#!/usr/bin/env node
/**
 * 把注入正文重新封装成 lib/asset-table.json（本包自己的盐）。
 *
 * 正文来源优先级：
 *   1. --from <file>            明文文件
 *   2. assets/default-prompt.md 本地明文（不进 git）
 *   3. --community <dir>        直接从 dsh-purge-community 的 lib/asset-table.js 解出来
 *
 *   node scripts/reseal-prompt.mjs --community ../dsh-purge-community
 *
 * 为什么需要它：community 的正文是用它自己的盐（lib/table-key.js）封的，
 * 本包的 mixKey 不同，照搬过来解不开。转发一次，正文一个字不改，只有密文换壳。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { sealSlot } from '../lib/table-key.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

/** 统一换行、去 BOM、去尾部空行——和 lib/prompt.js 的 normalizeText 同口径。 */
function normalize(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
}

async function main() {
  const explicit = arg('from')
  const communityDir = path.resolve(ROOT, arg('community', '../dsh-purge-community'))
  let text = ''
  let source = ''

  if (explicit) {
    text = fs.readFileSync(path.resolve(ROOT, explicit), 'utf8')
    source = explicit
  } else {
    const local = path.join(ROOT, 'assets', 'default-prompt.md')
    if (fs.existsSync(local)) {
      text = fs.readFileSync(local, 'utf8')
      source = 'assets/default-prompt.md'
    }
  }

  if (!text) {
    const reader = path.join(communityDir, 'lib', 'table-read.js')
    if (!fs.existsSync(reader)) {
      console.error(`找不到正文来源：${reader}`)
      console.error('用 --from <file> 指定一份明文，或把明文放到 assets/default-prompt.md')
      process.exit(1)
    }
    const mod = await import(pathToFileURL(reader).href)
    text = mod.openSlot()
    source = `${communityDir}/lib/asset-table.js`
  }

  const body = normalize(text)
  if (!body.trim()) {
    console.error('正文是空的，不封装。')
    process.exit(1)
  }

  const sealed = sealSlot(body)
  const dest = path.join(ROOT, 'lib', 'asset-table.json')
  fs.writeFileSync(dest, `${JSON.stringify(sealed, null, 2)}\n`, 'utf8')
  const bytes = fs.statSync(dest).size
  console.log(`已封装 ${path.relative(ROOT, dest)}：正文 ${body.length} 字符 / ${Buffer.byteLength(body, 'utf8')} 字节 → 产物 ${bytes} 字节`)
  console.log(`来源：${source}`)
}

await main()
