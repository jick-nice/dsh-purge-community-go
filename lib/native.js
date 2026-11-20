// dsh-go 原生界面：注册 / 重注册 / 桥探测。
//
// 手机上的 App 诊断页会显示「最近视图 882 B」这类读数，那说明 view() 已经通了；
// 剩下的问题通常出在 strip / composer action 这一侧，所以这里把每一步都记进
// $DSH_HOME/dsh-purge/native-diag.log，出问题时能直接看出是哪一环没接上。
import fs from 'node:fs'
import path from 'node:path'
import { installDshGo, uninstallDshGo, detectBridge } from './dshgo.js'

const DIAG_MAX = 256 * 1024

/** 桥的名字在不同 dsh-go 版本上不完全一致，按顺序探测。 */
export const BRIDGE_NAMES = ['dshGo', 'dshGoBridge', 'dshGoRuntime', 'dshGoNative']

function trimDiag(file) {
  try {
    const st = fs.statSync(file)
    if (st.size <= DIAG_MAX) return
    const buf = fs.readFileSync(file)
    fs.writeFileSync(file, buf.subarray(Math.floor(buf.length / 2)))
  } catch {
    /* 砍不掉就算了 */
  }
}

/** 把诊断追加进文件——引擎的 stderr 指向 /dev/null，console 输出看不到。 */
export function diag(home, payload) {
  try {
    const dir = path.join(home, 'dsh-purge')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'native-diag.log')
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n')
    trimDiag(file)
  } catch {
    /* 写不进就算了，不能因为诊断挂掉插件 */
  }
}

/**
 * 注册原生界面。桥没就绪时不放弃：退到定时重试，直到装上或插件卸载。
 * @param {any} ctx 插件自己的 ctx
 * @param {{ home: string, config: any, warn: (m: string) => void }} deps
 */
export function installNative(ctx, deps) {
  const { home, config, warn } = deps
  let registered = []
  let disposed = false
  let bridge = detectBridge(ctx, BRIDGE_NAMES)
  let bridgeName = ''

  // 先把「拿到什么」记下来——出问题时这行是唯一的线索。
  diag(home, {
    stage: 'enter',
    hasCtx: Boolean(ctx),
    hasBridge: Boolean(bridge),
    bridgeType: typeof bridge,
    bridgeKeys: bridge && typeof bridge === 'object' ? Object.keys(bridge) : [],
    strip: bridge ? typeof bridge.strip : 'n/a',
    panel: bridge ? typeof bridge.panel : 'n/a',
    on: bridge ? typeof bridge.on : 'n/a',
    refresh: bridge ? typeof bridge.refresh : 'n/a',
  })
  if (!bridge) {
    // 早期版本里桥可能在 apply 之后才就绪；这里只记一笔，重试由下面的定时器负责。
    diag(home, { stage: 'bridge-missing', willRetry: true })
  }

  const rearm = () => {
    if (disposed) return
    let live = false
    try {
      live = typeof registered?.isLive === 'function' ? registered.isLive() : false
    } catch {
      live = false
    }
    // 还活着就别动它——重注册会让 App 取消订阅再重订，面板会闪一下。
    if (live) return
    if (!bridge) {
      bridge = detectBridge(ctx, BRIDGE_NAMES)
      if (!bridge) {
        diag(home, { stage: 'rearm-skip', reason: 'bridge 仍未就绪' })
        return false
      }
      diag(home, { stage: 'bridge-found-late', bridgeKeys: Object.keys(bridge) })
    }
    try {
      registered = uninstallDshGo(registered)
    } catch {
      /* 旧注册已经没了 */
    }
    try {
      registered = installDshGo(ctx, { ...deps, bridge, diag })
      diag(home, { stage: 'rearm', registered })
      return true
    } catch (error) {
      warn(`dsh-go 原生界面注册失败：${error?.message || error}`)
      diag(home, { stage: 'rearm-error', message: String(error?.message || error) })
      return false
    }
  }

  rearm()

  // 引擎启动那一小段时间里桥接服务可能被换掉或还没起来，把注册一起带走。
  // 前五个时间点覆盖启动窗口；之后改成慢速巡检，只到「真的活了」为止——
  // 诊断页里那句「插件已停用或找不到 /runtime/purge-alert」就是注册被清掉、
  // 而 App 又没重新订阅造成的：它在等一个永远不会来的 producer。
  const timers = []
  const stop = () => {
    for (const t of timers) clearTimeout(t)
    timers.length = 0
    if (poll) clearInterval(poll)
  }
  for (const delay of [1_000, 3_000, 8_000, 20_000, 60_000]) {
    const t = setTimeout(() => {
      if (disposed) return
      if (registered?.isLive?.()) return
      rearm()
    }, delay)
    if (typeof t.unref === 'function') t.unref()
    timers.push(t)
  }
  // 慢速巡检：30 秒一次，最多 10 分钟。isLive() 一真就停，不做无谓的重注册。
  let poll = null
  let ticks = 0
  poll = setInterval(() => {
    if (disposed) return stop()
    if (registered?.isLive?.()) return stop()
    ticks += 1
    if (ticks > 20) {
      diag(home, { stage: 'rearm-giveup', ticks, registered })
      return stop()
    }
    rearm()
    return undefined
  }, 30_000)
  if (typeof poll.unref === 'function') poll.unref()

  // 句柄挂在 bridge 上，让它随插件一起被回收。
  try {
    if (bridge && typeof bridge.effect === 'function') {
      bridge.effect(() => () => {
        disposed = true
        stop()
        try {
          uninstallDshGo(registered)
        } catch {
          /* 已经没了 */
        }
      }, 'dsh-purge-community-go: native timers')
    }
  } catch {
    /* 没有 effect 就退化成「只靠 disposed 标志」 */
  }

  diag(home, { stage: 'done', registered, hasBridge: Boolean(bridge) })
  return Boolean(bridge)
}
