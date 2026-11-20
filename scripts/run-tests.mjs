#!/usr/bin/env node
/**
 * 进程内测试运行器：按文件名顺序 import 每个 test/*.test.js。
 *
 * 为什么不直接 `node --test test/*.test.js`：那个模式下每个测试文件是一个子进程，
 * 部分受限环境（以及 Android proot 里的管道权限）会直接 EPERM。
 * 这里改成同一进程内跑，node:test 仍然给完整报告与正确的退出码。
 *
 *   node scripts/run-tests.mjs [过滤词]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const filter = String(process.argv[2] || '').trim()

const dir = path.join(ROOT, 'test')
const files = fs
  .readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => !filter || name.includes(filter))
  .sort()

if (!files.length) {
  console.error(`没有匹配的测试文件（filter=${filter || '(空)'}）`)
  process.exit(1)
}

// 先把所有文件都 import 进来（注册测试），再让 node:test 统一跑。
// 逐个 await 不行：第一个文件跑完、队列一空，进程就退出了，后面的文件根本没导入。
await Promise.all(files.map((name) => import(pathToFileURL(path.join(dir, name)).href)))
