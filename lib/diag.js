// 原生界面诊断报告：一份纯文本，能直接贴给人看。
//
// 为什么需要它：手机上的 dsh-go 引擎 stderr 指向 /dev/null，App 的「原生界面」诊断页
// 只给一句「插件已停用或找不到 /runtime/purge-alert」。判断到底卡在哪一环——
// 原生目录没建、清单没被扫到、桥对象没有 strip 方法、还是注册被启动期清掉——
// 只能靠把现场打出来。
//
// 两条通道共用这一份：/purge diag 命令，和 purge_diag 工具（模型可以直接调完念给你听）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome, purgeDir } from './home.js'

const NATIVE_DIR_NAME = 'dsh-purge-community-go'

/** 日志里每个阶段只留最后一条：重注册会把日志刷满，全列出来没法看。 */
function condense(lines) {
  const records = []
  for (const line of lines) {
    try {
      records.push(JSON.parse(line))
    } catch {
      /* 半截行（进程被杀时常见）跳过 */
    }
  }
  const byStage = new Map()
  for (const rec of records) if (rec.stage) byStage.set(rec.stage, rec)
  return { records, byStage }
}

/**
 * @param {string} home
 * @returns {{ text: string, savedTo?: string }}
 */
export function buildDiagReport(home = dshHome()) {
  const nativeDir = path.join(home, 'dsh-go', 'plugins', NATIVE_DIR_NAME)
  const logFile = path.join(purgeDir(home), 'native-diag.log')
  const out = []

  out.push('=== 破甲原生界面诊断 ===')
  out.push(`DSH_HOME   ${dshHome()}`)
  out.push(`插件版本   ${packageVersion()}`)
  out.push(`原生目录   ${nativeDir}`)
  out.push(`目录存在   ${fs.existsSync(nativeDir)}`)

  if (fs.existsSync(nativeDir)) {
    try {
      const entries = fs.readdirSync(nativeDir)
      out.push(`目录内容   ${entries.slice(0, 12).join(' ')}${entries.length > 12 ? ' …' : ''}`)
      const pkgFile = path.join(nativeDir, 'package.json')
      if (fs.existsSync(pkgFile)) {
        const manifest = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
        const c = manifest?.dshGo?.contributes || {}
        const count = (key) => (Array.isArray(c[key]) ? c[key].length : 0)
        out.push(
          `清单       name=${manifest.name} dshGo=v${manifest?.dshGo?.v ?? '?'}` +
            ` 胶囊=${count('composer.actions')} 面板=${count('panels')} 状态条=${count('composer.strip')}`,
        )
        // 清单里的 id 必须和代码里注册的 id 一致，否则 App 找到插件也接不上。
        const ids = {
          action: Array.isArray(c['composer.actions']) ? c['composer.actions'].map((x) => x?.id).join(',') : '',
          panel: Array.isArray(c.panels) ? c.panels.map((x) => x?.id).join(',') : '',
          strip: Array.isArray(c['composer.strip']) ? c['composer.strip'].map((x) => x?.id).join(',') : '',
        }
        out.push(`清单 id    胶囊=${ids.action} 面板=${ids.panel} 状态条=${ids.strip}`)
        out.push('代码 id    胶囊=purge-status 面板=status 状态条=purge-alert')
      } else {
        out.push('清单       缺 package.json ——install.sh 第 2 步可能没跑完')
      }
    } catch (error) {
      out.push(`目录读取失败 ${error?.message || error}`)
    }
  } else {
    out.push('说明       原生目录不存在：App 不会为这个插件画胶囊和状态条。')
    out.push(`           修：cd ~/dsh-purge-community-go && sh install.sh`)
  }

  if (!fs.existsSync(logFile)) {
    out.push('')
    out.push(`诊断日志   没有（${logFile}）`)
    out.push('说明       插件可能压根没执行到原生界面注册这一步。')
    return { text: out.join('\n') }
  }

  const raw = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
  const { records, byStage } = condense(raw)
  out.push(`诊断日志   ${fs.statSync(logFile).size} 字节 / ${records.length} 条记录`)
  out.push('')
  out.push('各阶段最后一次：')
  for (const [stage, rec] of byStage) {
    const detail = { ...rec }
    delete detail.at
    delete detail.stage
    const body = JSON.stringify(detail)
    out.push(`  ${stage.padEnd(14)} ${body.length > 260 ? `${body.slice(0, 260)}…` : body}`)
  }
  out.push('')
  out.push('最近 5 条原始记录：')
  for (const rec of records.slice(-5)) out.push(`  ${JSON.stringify(rec).slice(0, 320)}`)
  out.push('')
  out.push('=== 到这里结束，整段贴出来即可 ===')
  return { text: out.join('\n') }
}

/** 顺便存一份到 dsh-purge/diag-report.txt，方便用文件管理器取走。 */
export function saveDiagReport(home = dshHome()) {
  const { text } = buildDiagReport(home)
  const file = path.join(purgeDir(home), 'diag-report.txt')
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${text}\n`, 'utf8')
    return { text, savedTo: file }
  } catch {
    return { text, savedTo: '' }
  }
}

function packageVersion() {
  try {
    // 用 fileURLToPath 而不是 URL.pathname：Windows 上会带 %20，路径里有空格就 ENOENT。
    const here = path.dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
    return pkg.version || '?'
  } catch {
    return '?'
  }
}