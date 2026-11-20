// dsh-go 原生界面：输入框上方的胶囊 + 点开的面板 + 出问题时的状态条。
//
// 和旧实现的关键差别（旧实现把手机卡死过一次）：
//   view 只返回**静态骨架**，值全是数据绑定 { $: 'data.x' }，一次计算都不做；
//   真正的取数在 data() 里，异步算完 emit 出去，30 秒一次。
// App 每次重绘都会调 view，把扫盘塞进 view 里等于每次重绘扫一遍全部目标文件。
import fs from 'node:fs'
import path from 'node:path'
import { snapshot, patchSnapshot, invalidatePatches } from './view.js'
import { toggle, patchApply, patchRevert } from './ops.js'
import { readState, setEnabled } from './state.js'
import { DEFAULT_VARIANT } from './prompt.js'
import { readTuning, writeTuning } from './community.js'

const PANEL_ID = 'status'
const ALERT_ID = 'purge-alert'
const REFRESH_MS = 30_000

const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

/** 低于这个已生效条数就判定「补丁层被覆盖」。 */
const APPLIED_FLOOR = 10

/**
 * 当前默认模型。
 *
 * 面板上「模型」这一行读 snap.last.model，那是「最后一次提示词装配时报上来的模型」，
 * 只有发过消息才有值——刚装好、还没聊天时是空的，看着像破甲没生效。
 * 所以发过消息用真值，没发过就从 profile 的 cordis.patch.yml 里读 agent-default-model。
 */
function defaultModel(home) {
  try {
    const base = path.join(home, 'profiles')
    if (!fs.existsSync(base)) return ''
    for (const name of fs.readdirSync(base)) {
      const file = path.join(base, name, 'cordis.patch.yml')
      if (!fs.existsSync(file)) continue
      const text = fs.readFileSync(file, 'utf8')
      const block = text.split(/^- id:/m).find((part) => part.startsWith(' agent-default-model') || part.startsWith('agent-default-model'))
      const m = (block || text).match(/^\s*model:\s*([^\s#]+)/m)
      if (m && m[1]) return m[1]
    }
  } catch {
    /* 读不到就算了 */
  }
  return ''
}

/**
 * 已知打不上却不用管的那批：按名字前缀归类。
 * 补丁表来自桌面版整理的数据，手机上有些目标包/代码路径根本不存在。
 */
const HARMLESS = [
  { re: /^LIANGSHEN/i, why: '第三方预设包，本机没装' },
  { re: /^(PRESET_|MINIMAL_)/i, why: '预设变体，手机只跑 web 预设' },
  { re: /^(DESKTOP_|OFFICIAL_DESKTOP_)/i, why: 'Electron 外壳，手机不是这个运行形态' },
  { re: /^HOOKS_/i, why: 'Claude Code / Codex 钩子，手机没装那两个工具' },
  { re: /^ANTHROPIC_/i, why: '别的模型后端，手机只连 DeepSeek' },
  { re: /^INSPECTOR_/i, why: 'Web 端 inspector 面板，手机用不到' },
]

/** 一条补丁该拿它怎么办。 */
export function patchAdvice(row) {
  const name = String(row?.name || '')
  const harmless = HARMLESS.find((h) => h.re.test(name))
  switch (row?.status) {
    case 'applied':
      return '已生效，不用管'
    case 'partial':
      return '不用管，命中的那套已生效'
    case 'no_pkg':
      return '不用管，手机没有这个包'
    case 'no_needle':
      return '不用管，这条数据没查找串'
    case 'hit':
      return '可以再打一次'
    case 'drifted':
      return '可以再打一次，被升级冲掉了'
    case 'miss':
      return harmless ? `不用管，${harmless.why}` : row?.desktopOnly ? '不用管，桌面专属' : '不用管，引擎这版写法不同'
    case 'no_file':
      return harmless ? `不用管，${harmless.why}` : row?.desktopOnly ? '不用管，桌面专属' : '不用管，这版引擎没这条路径'
    default:
      return '看一眼再说'
  }
}

/** 算一份面板要用的数据。慢，只在 data() 里调。 */
function collect(home, config) {
  const snap = snapshot(home, config)
  const p = patchSnapshot(config?.aiRoot)
  const rows = Array.isArray(p?.rows) ? p.rows : []
  const { counts, covered, pending, gap, optInWaiting, actionable } = classifyRows(rows)
  const applicable = Number(p?.applicable) || Math.max(0, rows.length - counts.noPkg)
  const brokenLayer = rows.length > 0 && covered < APPLIED_FLOOR
  const reverted = counts.hit > 5
  const injectOff = snap.enabled === false
  const patchOff = reverted || brokenLayer
  const healthy = rows.length > 0 && !injectOff && pending === 0 && !patchOff
  const complete = actionable > 0 && covered >= actionable

  const tone = rows.length === 0 || brokenLayer
    ? 'bad'
    : injectOff || reverted ? 'bad'
      : pending > 0 ? 'warn' : 'good'

  let summary
  if (rows.length === 0) {
    summary = '没扫到引擎包，补丁层没法判定。点「重读」再试一次。'
  } else if (injectOff && patchOff) {
    summary = '注入关着，补丁也被冲掉了。点「一键注入」，一次补齐，然后重启引擎。'
  } else if (patchOff) {
    summary = reverted
      ? `${counts.hit} 条补丁被冲掉了。点「一键注入」补齐，然后重启引擎。`
      : '补丁层被 App 更新覆盖了。点「一键注入」重打，然后重启引擎。'
  } else if (injectOff) {
    summary = '注入层关着。点「开关注入」或「一键注入」打开。'
  } else if (healthy && complete) {
    summary = '一切正常，本机该打的补丁全都生效了。'
  } else if (healthy) {
    summary = '注入正常工作，补丁层没有待处理项。'
  } else {
    summary = `还有 ${pending} 条要打，点「一键注入」一次补齐。`
  }

  // 明细分两档，避免手机上刷出一屏：
  //   · 能动手的（待打 / 被冲掉）逐条列出来，带编号和名字；
  //   · 其余只给一行「N 条 + 一句话」，点开 /purge patches 才看全。
  // 65 条已生效逐条铺出来没有信息量，只会把真正要看的那几条挤出屏幕。
  const ACTIONS = [
    ['hit', '待打', '点「一键注入」补上', true],
    ['drifted', '被冲掉', 'App 更新时丢了，重打即可', true],
  ]
  const QUIET = [
    ['partial', '部分命中', '命中的那套已生效'],
    ['miss', '这版没有', '引擎里没这段代码'],
    ['no_file', '路径不在', '引擎里没这个文件'],
    ['no_needle', '数据缺项', '表里这条没有查找串'],
    ['no_pkg', '桌面专属', '手机没装这个包'],
    ['applied', '已生效', ''],
  ]
  const detail = []
  for (const [key, label, note, expand] of ACTIONS) {
    const list = rows.filter((row) => row?.status === key)
    if (list.length === 0) continue
    detail.push({ type: 'text', text: `${label} · ${list.length}　${note}`, tone: 'warn' })
    if (expand) {
      detail.push({
        type: 'list',
        items: list.slice(0, 8).map((row) => ({
          title: `${row?.id ?? ''}. ${String(row?.name || '').replace(/_/g, ' ')}`,
          subtitle: patchAdvice(row),
        })),
      })
      if (list.length > 8) detail.push({ type: 'text', text: `另有 ${list.length - 8} 条`, tone: 'muted' })
    }
  }
  for (const [key, label, note] of QUIET) {
    const list = rows.filter((row) => row?.status === key)
    if (list.length === 0) continue
    detail.push({ type: 'text', text: `${label} · ${list.length}${note ? `　${note}` : ''}`, tone: key === 'applied' ? 'good' : 'muted' })
  }
  if (detail.length === 0) detail.push({ type: 'text', text: '没有可显示的内容', tone: 'muted' })

  // caption 只说「还差什么」，数字交给上方的大号 metric。
  const caption = (() => {
    if (rows.length === 0 || applicable === 0) return '没扫到引擎包'
    const bits = []
    if (pending > 0) bits.push(`${pending} 条等着打`)
    else if (complete) bits.push('本机适用全部生效')
    if (gap > 0) bits.push(`${gap} 条这版引擎没有`)
    if (counts.noPkg > 0) bits.push(`${counts.noPkg} 条桌面专属`)
    return bits.join(' · ')
  })()

  // 一行小字：社区版带来的那几个开关，和它们当前的值。
  const extras = [
    `位置 ${snap.injectPosition}`,
    `强化段 ${snap.boost ? '开' : '关'}`,
    snap.probe ? `探针 ${snap.probe.nonce}` : '探针 无',
    snap.categories ? `分类 ${snap.categories}` : '分类 关',
    optInWaiting ? `可选 ${optInWaiting} 条未打` : '',
  ].filter(Boolean).join(' · ')

  return {
    summary,
    tone: healthy ? 'good' : tone,
    enabled: snap.enabled ? '开' : '关',
    enabledTone: snap.enabled ? 'good' : 'warn',
    bytes: KB(snap.bytes || 0),
    variant: !snap.variant || snap.variant === DEFAULT_VARIANT ? '默认' : snap.variant,
    model: snap.last?.model || defaultModel(home) || '跟随引擎默认',
    patchText: reverted ? '未打' : `${covered}/${actionable}`,
    patchCaption: caption,
    position: snap.injectPosition,
    boost: snap.boost ? '开' : '关',
    probe: snap.probe ? snap.probe.nonce : '无',
    probeActive: Boolean(snap.probe),
    needText: pending === 0 ? '没有要处理的' : `${pending} 条要处理`,
    extras,
    // 状态条只在真正需要人动手时出现：注入关了、或补丁被冲掉。
    // 单纯的「这版引擎没有这几条」不该弹红条——那是信息，不是故障。
    alert: injectOff || patchOff,
    alertText: injectOff && patchOff
      ? '破甲未工作 · 点开修复'
      : injectOff
        ? '破甲已关 · 点开恢复'
        : '补丁被冲掉 · 点开重打',
    detail,
    empty: detail.length === 0,
  }
}

/**
 * 把 88 条扫描结果分成四类。互斥且穷尽，加起来等于行数。
 *
 *   covered   已生效 + 部分命中：命中的那套写法已经落到文件里
 *   pending   点一下能解决的：待打 / 被升级冲掉（opt-in 的两条不算，它们默认不打）
 *   applied / partial 之外的「这版引擎没有」：miss / no_file / no_needle
 *   desktop   目标包本来就不存在
 *
 * 「全绿」只看 pending。之前把 miss / no_file 也算成待处理，于是无论怎么点都消不掉，
 * 面板永远挂在「12 条需要处理」——那不是故障，只是这版引擎没有对应的代码。
 *
 * @param {Array<{status?:string,optIn?:boolean,desktopOnly?:boolean}>} rows
 */
export function classifyRows(rows) {
  const counts = { applied: 0, partial: 0, miss: 0, noNeedle: 0, noPkg: 0, drifted: 0, hit: 0, noFile: 0 }
  // 状态名和计数键不是一一对应（no_needle / no_file / no_pkg 是三个特例），
  // 用显式映射而不是 `s in counts`——否则 no_pkg 会被静默漏掉，桌面专属数永远是 0。
  const KEY = { applied: 'applied', partial: 'partial', miss: 'miss', drifted: 'drifted', hit: 'hit', no_needle: 'noNeedle', no_file: 'noFile', no_pkg: 'noPkg' }
  for (const row of rows) {
    const key = KEY[row?.status]
    if (key) counts[key] += 1
  }
  const covered = counts.applied + counts.partial
  let pending = counts.hit + counts.drifted
  let optInWaiting = 0
  for (const row of rows) {
    if (!row?.optIn) continue
    if (row.status === 'hit' || row.status === 'drifted') optInWaiting += 1
  }
  pending = Math.max(0, pending - optInWaiting)
  const gap = counts.miss + counts.noFile + counts.noNeedle
  return {
    counts,
    covered,
    pending,
    gap,
    optInWaiting,
    actionable: covered + pending,
    desktop: counts.noPkg,
  }
}
/* ── 面板视图 ─────────────────────────────────────────────────────── */

/** 静态骨架：不碰文件、不算任何东西，只描述布局与绑定路径。 */
export function buildView() {
  return {
    v: 1,
    type: 'stack',
    title: '破甲状态',
    children: [
      // 1. 一句话结论：颜色 = 现在的健康度
      { type: 'callout', tone: { $: 'data.tone' }, text: { $: 'data.summary' } },

      // 2. 两个大数字并排：补丁进度 + 注入开关。这是唯一需要一眼看到的两件事。
      {
        type: 'row',
        children: [
          {
            type: 'metric',
            label: '补丁',
            value: { $: 'data.patchText' },
            tone: { $: 'data.tone' },
            caption: { $: 'data.patchCaption' },
          },
          {
            type: 'metric',
            label: '注入',
            value: { $: 'data.enabled' },
            tone: { $: 'data.enabledTone' },
            caption: { $: 'data.needText' },
          },
        ],
      },

      // 3. 注入层的细节。只留最常看的四个，其余收进下面那行小字。
      {
        type: 'keyValue',
        items: [
          ['正文', { $: 'data.bytes' }],
          ['变体', { $: 'data.variant' }],
          ['模型', { $: 'data.model' }],
        ],
      },
      { type: 'text', text: { $: 'data.extras' }, tone: 'muted' },

      // 4. 动作。上限 4 个，「一键注入」是主按钮——装完 / 更新后 / 重置后都点它。
      { type: 'actions', items: [
        { label: '一键注入', action: 'oneClick', icon: 'bolt', style: 'primary' },
        { label: '重读', action: 'refresh', icon: 'refresh' },
        { label: '开关注入', action: 'toggle', icon: 'power' },
        { label: '还原补丁', action: 'patchRevert', icon: 'retry' },
      ] },

      // 5. 明细：能动手的逐条列出，其余按状态给一行小结。
      { type: 'text', text: '明细', tone: 'muted' },
      { type: 'stack', children: { $: 'data.detail' } },
    ],
  }
}

/**
 * 桥探测：不同 dsh-go 版本上服务名不完全一致，按顺序试。
 * ctx.get(name, false) 是 cordis 里唯一「不声明 inject 也能拿服务」的口子。
 */
export function detectBridge(ctx, names = ['dshGo', 'dshGoBridge', 'dshGoRuntime', 'dshGoNative']) {
  for (const name of names) {
    try {
      const value = typeof ctx?.get === 'function' ? ctx.get(name, false) : null
      if (value && typeof value === 'object') return value
    } catch {
      /* 这个宿主没有这个名字 */
    }
  }
  return null
}

/** 在若干候选对象里找第一个可用的方法，返回 { fn, label }。 */
function pickMethod(candidates, key) {
  for (const [label, host] of candidates) {
    try {
      if (host && typeof host[key] === 'function') return { fn: host[key].bind(host), label: `${label}.${key}` }
    } catch {
      /* 取属性就抛的对象，跳过 */
    }
  }
  return null
}

/**
 * 注册面板与状态条。桥不存在时（网页版、纯终端）静默跳过。
 *
 * 传进来的应当是**插件自己的 ctx**，不是 ctx.inject(['dshGo']) 的回调 ctx ——
 * 后者是个子 fiber 的上下文，桥接服务重建时会被整体销毁，连带把注册一起清掉。
 *
 * @param {any} ctx 插件自己的 ctx
 * @param {{ home: string, config: any, warn: (m: string) => void, diag?: Function, bridge?: any }} deps
 * @returns {string[]} 注册到了哪些面
 */
export function installDshGo(ctx, deps) {
  const { home, config, warn } = deps
  const note = typeof deps.diag === 'function' ? deps.diag : () => {}
  const go = deps.bridge || detectBridge(ctx)
  if (!go || typeof go !== 'object') return []

  // 状态条与面板可能挂在桥本身上，也可能挂在 composer / runtime / ui 子对象上。
  // 不同版本之间这一点变过，所以四个位置都试，并把命中的那个记进诊断。
  const candidates = [
    ['bridge', go],
    ['composer', go.composer],
    ['runtime', go.runtime],
    ['ui', go.ui],
    ['native', go.native],
  ]

  const registered = []
  const cleanups = []
  const timers = new Set()
  const stripEmitters = new Set()
  // 用 Set 而不是单槽：同一个面板声明了 session.tab / chat.panel / features 三个挂载点，
  // 单槽会让第二个挂载顶掉第一个，关掉任意一个还会把另一个的刷新通道置空。
  const panelEmitters = new Set()

  const push = () => {
    let data
    try {
      data = collect(home, config)
    } catch (error) {
      warn(`dsh-go 取状态失败：${error?.message || error}`)
      return
    }
    for (const emit of [...panelEmitters]) {
      try { emit(data) } catch { /* 这个面板已关闭 */ }
    }
    // 状态条只在真正需要人动手时出现：注入关了、或补丁被冲掉。
    // 单纯的「这版引擎没有这几条」不该弹红条——那是信息，不是故障。
    for (const emit of [...stripEmitters]) {
      try {
        emit(data.alert ? { text: data.alertText, icon: 'warning', tone: 'warn' } : { text: '' })
      } catch { /* 状态条未显示 */ }
    }
    // bridge.refresh 只通知状态条重新拉取；面板重绘走 action 返回值里的 { refresh: true }。
    // 两条通道各管一半，注册完之后要主动推一次，否则 App 可能一直显示旧清单
    // （诊断页那行「插件已停用或找不到 /runtime/purge-alert」就是这么来的）。
    try {
      if (typeof go.refresh === 'function') go.refresh()
    } catch {
      /* 旧桥接没有 refresh */
    }
  }

  const strip = pickMethod(candidates, 'strip')
  if (strip) {
    try {
      cleanups.push(strip.fn(ALERT_ID, (scope, emit) => {
        stripEmitters.add(emit)
        try { emit({ text: '' }) } catch { /* 未显示 */ }
        const first = setTimeout(push, 0)
        if (typeof first.unref === 'function') first.unref()
        timers.add(first)
        const timer = setInterval(push, REFRESH_MS)
        if (typeof timer.unref === 'function') timer.unref()
        timers.add(timer)
        return () => {
          clearInterval(timer)
          timers.delete(timer)
          stripEmitters.delete(emit)
        }
      }))
      registered.push(`strip:${ALERT_ID}@${strip.label}`)
      note(home, { stage: 'strip-ok', via: strip.label })
    } catch (error) {
      warn(`状态条注册失败（${strip.label}）：${error?.message || error}`)
      note(home, { stage: 'strip-error', via: strip.label, message: String(error?.message || error) })
    }
  } else {
    warn('dsh-go 桥没有 strip / composer.strip，状态条跳过')
    note(home, {
      stage: 'strip-missing',
      hosts: candidates.map(([label, host]) => `${label}:${host && typeof host === 'object' ? Object.keys(host).join('|') : 'null'}`),
    })
  }

  const panel = pickMethod(candidates, 'panel')
  if (panel) {
    try {
      cleanups.push(panel.fn(PANEL_ID, {
        view: () => buildView(),
        data: (scope, emit) => {
          panelEmitters.add(emit)
          const first = setTimeout(push, 0)
          if (typeof first.unref === 'function') first.unref()
          timers.add(first)
          const timer = setInterval(push, REFRESH_MS)
          if (typeof timer.unref === 'function') timer.unref()
          timers.add(timer)
          return () => {
            clearInterval(timer)
            timers.delete(timer)
            panelEmitters.delete(emit)
          }
        },
        actions: {
          // 面板按钮的同步超时只有 3 秒；打补丁要扫 88 条目标、改几十个文件，
          // 手机上十几秒起步，必须用协议 §4.7 的 deferred（返回 { pending, result }）。
          refresh: () => {
            invalidatePatches()
            push()
            return { toast: '已重读' }
          },
          oneClick: () => ({
            pending: { label: '正在注入…', timeoutMs: 60000 },
            result: async (signal) => {
              let wasEnabled = true
              try {
                wasEnabled = readState(home).enabled !== false
                if (!wasEnabled) setEnabled(home, true)
              } catch (error) {
                return { toast: `开注入失败：${String(error?.message || error).slice(0, 20)}` }
              }
              try {
                if (signal?.aborted) return {}
                const r = patchApply(home, { root: config?.aiRoot })
                invalidatePatches()
                push()
                if (signal?.aborted) return {}
                if (!r?.ok) return { toast: `补丁失败：${String(r?.errors?.[0]?.error || '未知').slice(0, 24)}` }
                if (!(r.applied > 0)) return { toast: wasEnabled ? '破甲已正常工作，无需再打' : '注入已开，补丁已是最新' }
                return { toast: `补丁 ${r.applied} 条已打上，重启后生效` }
              } catch (error) {
                return { toast: `注入失败：${String(error?.message || error).slice(0, 24)}` }
              }
            },
          }),
          // 开关注入只是写一个 JSON + 扫一次盘，秒级以内，同步做；
          // 同步做还能让面板数据在同一个回调里推下去，顶部状态立刻变。
          toggle: () => {
            try {
              const { enabled } = toggle(home)
              push()
              return { toast: enabled ? '注入已开' : '注入已关' }
            } catch (error) {
              return { toast: `切换失败：${String(error?.message || error).slice(0, 24)}` }
            }
          },
          // 还原只是把备份里的文件复制回去，本机 74ms、手机上也就 1 秒内，同步做。
          patchRevert: () => {
            try {
              const before = patchSnapshot(config?.aiRoot).rows.filter((x) => x.status === 'applied').length
              const r = patchRevert(home, { root: config?.aiRoot })
              invalidatePatches()
              const after = patchSnapshot(config?.aiRoot).rows.filter((x) => x.status === 'applied').length
              push()
              if (r?.ok) {
                return { toast: after === before ? '没有可回退的补丁（不是本插件打的）' : `已还原 ${r.restored ?? 0} 个文件` }
              }
              const why = String(r?.errors?.[0]?.error || '未知原因')
              return { toast: why.includes('没有可还原') || why.includes('备份目录为空')
                ? '还没有插件备份，先点「一键注入」打一次'
                : `还原失败：${why.slice(0, 24)}` }
            } catch (error) {
              return { toast: `还原失败：${String(error?.message || error).slice(0, 24)}` }
            }
          },
        },
      }))
      registered.push(`panel:${PANEL_ID}@${panel.label}`)
      note(home, { stage: 'panel-ok', via: panel.label })
    } catch (error) {
      warn(`面板注册失败（${panel.label}）：${error?.message || error}`)
      note(home, { stage: 'panel-error', via: panel.label, message: String(error?.message || error) })
    }
  } else {
    warn('dsh-go 桥没有 panel / composer.panel，面板跳过')
    note(home, { stage: 'panel-missing' })
  }

  registered.cleanups = cleanups
  // App 只要还在订阅面板或状态条，就说明注册活着（producer 是订阅时才调的）。
  registered.isLive = () => panelEmitters.size > 0 || stripEmitters.size > 0
  return registered
}

/** 撤掉上一次注册。服务换代或插件卸载时调用。 */
export function uninstallDshGo(registered) {
  for (const dispose of registered?.cleanups ?? []) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch {
      /* 旧注册已经没了 */
    }
  }
  return []
}
