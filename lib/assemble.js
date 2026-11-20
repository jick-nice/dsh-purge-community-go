// 提示词组装：把注入段放到最前（或尾部，可配），并按需压掉会与本插件抢身份的官方段。
//
// 桌面版靠改引擎 assemble() 实现；这里只用官方 `system-prompt/assemble` waterfall，
// 所以换任何 0.2.x 引擎（含 dsh-go 的 Android 引擎）都不用重打补丁。
//
// 从 community 版带过来的两点：
//   · injectPosition = head | tail | both（community 的 tuning.json 语义）
//   · 尾部 boost 段：order 远大于普通段，长上下文里也在最后
import { resolveInject, modelOf, escapeInterpolation } from './prompt.js'
import { readState, noteInject } from './state.js'

/** 头部注入正文。 */
export const INJECT_SECTION = 'dsh-purge'
/** 尾部注入正文（injectPosition=tail|both 时才有）。 */
export const TAIL_SECTION = 'dsh-purge-tail'
/** 尾部强化段。 */
export const BOOST_SECTION = 'dsh-purge-boost'
/** 后置补充段（配置里写了 postPrompt 才有）。 */
export const POST_SECTION = 'dsh-purge:post'

export const INJECT_ORDER = -100000
/** 与 community 一致：WEB_SURFACE 之后、persona-suffix 之前。 */
export const TAIL_ORDER = 10150
export const BOOST_ORDER = -50000

/** 本插件自有段（含能力协议段）：一起排到边上，并保持它们在原列表里的相对顺序。 */
const OWNED = /^(dsh-purge|dshpg-)/i
/** 尾部自有的段名。 */
const TAIL_OWNED = /^(dsh-purge-tail|dsh-purge-boost)$/i
/** 官方身份段：与本插件的 `<project_instructions>` 正文冲突，默认压掉。 */
const CONFLICT = /^(harness:identity|deployment:persona-prefix|deployment:persona-suffix)$/i

/** 上一次组装的实际结果，给面板与工具显示「这次真注入了什么」。 */
let last = {
  at: '',
  bytes: 0,
  source: '',
  variant: 'default',
  model: '',
  sections: 0,
  dropped: [],
  enabled: false,
  position: 'head',
  boost: false,
  probe: false,
}

// 每步组装都会走这里，状态文件不能跟着每一步写一次盘（Android 的 PRoot 上尤其贵）。
const NOTE_TTL_MS = 60_000
let noted = { key: '', at: 0 }

function noteQuietly(home, info) {
  const key = `${info.bytes}|${info.source}|${info.model}`
  const now = Date.now()
  if (key === noted.key && now - noted.at < NOTE_TTL_MS) return
  noted = { key, at: now }
  try {
    noteInject(home, info)
  } catch {
    /* 状态文件写不动不影响注入 */
  }
}

export function rememberAssembly(info) {
  last = { ...last, ...info, at: new Date().toISOString() }
  return last
}

export function lastAssembly() {
  return last
}

export function isMine(name) {
  return OWNED.test(String(name || ''))
}

export function isConflict(name, dropConflicts = true) {
  return dropConflicts && CONFLICT.test(String(name || ''))
}

/**
 * 重排一份组装结果：
 *   头部自有段在最前 → 其余保序 → 尾部自有段在最后。
 * 冲突段按开关丢弃。注入正文用本次解析出来的文本覆盖。
 *
 * @param {{sections?: any[]}} assembly
 * @param {{ injectText?: string, tailText?: string, dropConflicts?: boolean }} [opts]
 */
export function rewriteAssembly(assembly, opts = {}) {
  if (!assembly || typeof assembly !== 'object') return assembly
  const sections = Array.isArray(assembly.sections) ? assembly.sections : []
  const injectText = typeof opts.injectText === 'string' ? opts.injectText : ''
  const tailText = typeof opts.tailText === 'string' ? opts.tailText : ''
  const dropConflicts = opts.dropConflicts !== false

  const head = []
  const rest = []
  const tail = []
  const dropped = []
  let injectSeen = false
  let tailSeen = false

  for (const section of sections) {
    if (!section || typeof section !== 'object') continue
    const name = String(section.name || '')
    if (!OWNED.test(name)) {
      if (isConflict(name, dropConflicts)) {
        dropped.push(name)
        continue
      }
      rest.push(section)
      continue
    }
    if (TAIL_OWNED.test(name)) {
      if (name === TAIL_SECTION || name === INJECT_SECTION) {
        if (tailSeen) continue
        tailSeen = true
        if (tailText) tail.push({ name: TAIL_SECTION, text: tailText, interpolate: false })
        else tail.push(section)
        continue
      }
      tail.push(section)
      continue
    }
    if (name === INJECT_SECTION || /^dsh-purge(:inject)?$/i.test(name)) {
      if (injectSeen) continue
      injectSeen = true
      head.push(injectText ? { name: INJECT_SECTION, text: injectText, interpolate: false } : section)
      continue
    }
    head.push(section)
  }

  if (injectText && !injectSeen) head.unshift({ name: INJECT_SECTION, text: injectText, interpolate: false })
  if (tailText && !tailSeen) tail.push({ name: TAIL_SECTION, text: tailText, interpolate: false })

  return { ...assembly, sections: [...head, ...rest, ...tail], __dropped: dropped }
}

/**
 * 安装 waterfall。宿主签名有 2 参与 3 参两种（旧 cordis），都兜住。
 * @param {any} ctx
 * @param {(context:any, assembly:any) => any} getOptions
 */
export function installAssembleHook(ctx, getOptions) {
  const handler = async (...args) => {
    const assembly = args[0]
    const context = args[1]
    const next = typeof args[args.length - 1] === 'function' && args.length >= 3 ? args[args.length - 1] : null

    let assembled = assembly
    if (next) {
      try {
        assembled = await next()
      } catch {
        assembled = assembly
      }
    }

    let opts = { enabled: false }
    try {
      opts = getOptions(context, assembled) || opts
    } catch {
      return assembled
    }

    try {
      if (!opts.enabled) {
        rememberAssembly({ enabled: false, bytes: 0, source: 'off', model: modelOf(context) })
        return assembled
      }
      const home = opts.home
      const state = readState(home)
      const model = modelOf(context) || modelOf(assembled)
      const resolved = resolveInject(home, {
        state,
        model,
        maxBytes: opts.maxBytes,
        categories: opts.categories !== false,
      })
      const position = ['head', 'tail', 'both'].includes(opts.position) ? opts.position : 'head'
      const wantHead = position === 'head' || position === 'both'
      const wantTail = position === 'tail' || position === 'both'
      const headText = resolved.text && wantHead ? escapeInterpolation(resolved.text) : ''
      const tailText = resolved.text && wantTail ? escapeInterpolation(resolved.text) : ''
      if (!headText && !tailText) return assembled
      const rewritten = rewriteAssembly(assembled, { injectText: headText, tailText, dropConflicts: opts.dropConflicts })
      const info = rememberAssembly({
        enabled: true,
        bytes: Buffer.byteLength(headText || tailText, 'utf8'),
        source: resolved.source,
        variant: resolved.variant,
        model,
        position,
        boost: opts.boost === true,
        probe: Boolean(opts.probe),
        sections: Array.isArray(rewritten.sections) ? rewritten.sections.length : 0,
        dropped: rewritten.__dropped || [],
        truncated: resolved.truncated,
      })
      noteQuietly(home, { bytes: info.bytes, source: info.source, model })
      delete rewritten.__dropped
      return rewritten
    } catch {
      return assembled
    }
  }

  try {
    ctx.on('system-prompt/assemble', handler)
    return true
  } catch {
    return false
  }
}
