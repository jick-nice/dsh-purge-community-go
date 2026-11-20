// 测试用的小工具：临时 DSH_HOME + 一个假的 @deepseek-ai 引擎目录。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 建一个临时 DSH_HOME，返回路径。 */
export function tempHome(prefix = 'purge-community-go-home-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 在临时目录里建一个假的引擎包目录 @deepseek-ai。 */
export function tempEngine(prefix = 'purge-community-go-engine-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(root, 'dsh-base'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'dsh-base', 'package.json'),
    JSON.stringify({ name: 'dsh-base', version: '0.2.2-rc.1' }),
    'utf8',
  )
  return root
}

/** 往假引擎里写一个包文件，返回文件路径。 */
export function writePkgFile(root, pkg, rel, text) {
  const file = path.join(root, pkg, ...rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

export function read(file) {
  return fs.readFileSync(file, 'utf8')
}

/** 清理临时目录（测试结束调）。 */
export function clean(...dirs) {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/** 909 号补丁（沙箱品牌词）在假引擎里的原始正文：三条 pattern 都在，且仍是合法 JS。 */
export const SANDBOX_POLICY_SOURCE = [
  '// fake dsh-sandbox-policy/lib/index.js',
  'export function policyText() {',
  '  return "Current DSH file policy: read-only, enforced by the DSH file sandbox.";',
  '}',
  'export const NOTE = "The DSH file sandbox does not restrict network access";',
  '',
].join('\n')
