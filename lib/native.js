// dsh-go 原生界面：注册 / 重注册。
// 没有 dsh-go 桥接的主机（纯终端、桌面 Web）走不到这里，插件其余部分照常工作。
import fs from 'node:fs'
import path from 'node:path'
import { installDshGo, uninstallDshGo } from './dshgo.js'

const DIAG_MAX = 256 * 1024

/** 超过 256KB 就砍掉前一半，避免长期运行把日志堆成几 MB（proot 上读写都慢）。 */
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
function diag(home, payload) {
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
 * @param {any} ctx 插件自己的 ctx
 * @param {{ home: string, config: any, warn: (m: string) => void }} deps
 */
export function installNative(ctx, deps) {
  const { home, config, warn } = deps
  // 不能写 ctx.dshGo：cordis 会抛 cannot get property "dshGo" without inject。
  // ctx.get(name, false) 是唯一不声明 inject 也能拿服务的口子。
  let bridge = null
  try {
    bridge = typeof ctx?.get === 'function' ? ctx.get('dshGo', false) : null
  } catch {
    bridge = null
  }
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
  if (!bridge || typeof bridge !== 'object') {
    diag(home, { stage: 'abort', reason: 'bridge 不存在或不是对象' })
    return false
  }

  let registered = []
  let disposed = false

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
    try {
      registered = uninstallDshGo(registered)
    } catch {
      /* 旧注册已经没了 */
    }
    try {
      registered = installDshGo(ctx, { ...deps, diag })
      diag(home, { stage: 'rearm', registered })
    } catch (error) {
      warn(`dsh-go 原生界面注册失败：${error?.message || error}`)
    }
  }

  rearm()

  // 引擎启动那一小段时间里，桥接服务会被换掉一次，把我们先前的注册一起带走
  // （dsh-purge-go 上实测：注册 339 毫秒后被清空）。没法便宜地判断服务有没有换实例，
  // 所以在几个时间点各补一次注册，覆盖那段窗口；之后不再重复。
  const later = []
  for (const delay of [1_000, 3_000, 8_000, 20_000]) {
    const t = setTimeout(rearm, delay)
    if (typeof t.unref === 'function') t.unref()
    later.push(t)
  }
  // 句柄挂在 bridge 上，让它随插件一起被回收。
  try {
    if (typeof bridge.effect === 'function') {
      bridge.effect(() => () => {
        disposed = true
        for (const t of later) clearTimeout(t)
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

  diag(home, { stage: 'done', registered })
  return true
}
