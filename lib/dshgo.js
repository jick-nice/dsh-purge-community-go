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
  { re: /^PRESET_/i, why: '预设变体，手机只跑 web 预设' },
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
      return '不用管（命中那套已经生效）'
    case 'no_pkg':
      return '不用管（手机上没有这个包）'
    case 'no_needle':
      return '不用管（表里这条没查找串）'
    case 'hit':
      return '可以再打一次'
    case 'drifted':
      return '可以再打一次（被升级冲掉）'
    case 'miss':
      return harmless ? `不用管（${harmless.why}）` : row?.desktopOnly ? '不用管（桌面专属）' : '暂时打不上，需要看一眼'
    case 'no_file':
      return row?.desktopOnly ? '不用管（桌面专属）' : '文件路径不在（版本布局不同）'
    default:
      return '需要你自己确认'
  }
}

/** 算一份面板要用的数据。慢，只在 data() 里调。 */
function collect(home, config) {
  const snap = snapshot(home, config)
  const p = patchSnapshot(config?.aiRoot)
  const rows = Array.isArray(p?.rows) ? p.rows : []
  const counts = { applied: 0, partial: 0, miss: 0, noNeedle: 0, noPkg: 0, drifted: 0, hit: 0, noFile: 0 }
  // 「要不要处理」不看状态本身，看 patchAdvice 怎么判——它认得哪些是手机端天然打不上。
  let need = 0
  let optInPending = 0
  for (const row of rows) {
    const s = row?.status
    if (s === 'applied') counts.applied += 1
    else if (s === 'partial') counts.partial += 1
    else if (s === 'no_needle') counts.noNeedle += 1
    else if (s === 'no_pkg') counts.noPkg += 1
    else if (s === 'drifted') counts.drifted += 1
    else if (s === 'hit') counts.hit += 1
    else if (s === 'miss') counts.miss += 1
    else if (s === 'no_file') counts.noFile += 1
    // optIn（默认关闭）的那两条：没打上不是问题，只有用户显式列进白名单才打。
    if (row?.optIn && (s === 'hit' || s === 'miss')) {
      optInPending += 1
      continue
    }
    let advice = ''
    try { advice = patchAdvice(row) } catch { advice = '' }
    if (advice && !advice.includes('不用管') && !advice.includes('已生效')) need += 1
  }
  const applicable = Number(p?.applicable) || Math.max(0, rows.length - counts.noPkg)
  const brokenLayer = rows.length > 0 && counts.applied < APPLIED_FLOOR
  const reverted = counts.hit > 5
  const injectOff = snap.enabled === false
  const patchOff = reverted || brokenLayer
  const healthy = rows.length > 0 && !injectOff && need === 0 && counts.drifted === 0 && !patchOff

  const tone = !snap.enabled || rows.length === 0 || brokenLayer
    ? 'bad'
    : counts.drifted > 0 || need > 0 || reverted ? 'warn' : 'good'

  let summary
  if (rows.length === 0) {
    summary = '没找到引擎包，补丁层无法判定。点下面「重读」再试一次。'
  } else if (injectOff && patchOff) {
    summary = '破甲未正常工作：提示词注入和补丁都没生效。点下面的「一键注入」一次搞定。'
  } else if (patchOff) {
    summary = reverted
      ? `补丁还没打上（${counts.hit} 条待打）。点下面的「一键注入」，打完重启一次引擎。`
      : '补丁被覆盖了（App 更新会重置引擎）。点下面的「一键注入」，打完重启一次引擎。'
  } else if (injectOff) {
    summary = '提示词注入层已关闭。点下面的「一键注入」或「开关注入」打开。'
  } else if (healthy) {
    summary = '破甲能力完全正常。'
  } else {
    summary = `有 ${need} 条补丁需要处理，见下面的明细。`
  }

  // 每组一张表：状态 → 该状态的补丁名。手机上不要 88 行全铺。
  const groups = [
    ['hit', '可以再打'],
    ['drifted', '被升级冲掉'],
    ['miss', '打不上'],
    ['no_file', '目标文件缺失'],
    ['partial', '部分生效'],
    ['no_needle', '无目标句'],
    ['applied', '已生效'],
    ['no_pkg', '桌面专属'],
  ]
  const tables = []
  for (const [key, label] of groups) {
    const list = rows.filter((row) => row?.status === key)
    if (list.length === 0) continue
    tables.push({ type: 'text', text: `— ${label} ${list.length} —`, tone: 'muted' })
    tables.push({
      type: 'table',
      columns: ['#', '补丁', '说明'],
      rows: list.slice(0, 20).map((row) => [
        String(row?.id ?? ''),
        String(row?.name || ''),
        String(patchAdvice(row) || '').slice(0, 32),
      ]),
    })
    if (list.length > 20) tables.push({ type: 'text', text: `…另有 ${list.length - 20} 条未列出`, tone: 'muted' })
  }

  const caption = (() => {
    if (rows.length === 0 || applicable === 0) return '没有扫描到引擎包'
    if (reverted) return `手机适用 ${applicable} 条，${counts.hit} 条等着打`
    const needWork = need
    const cannotUse = Math.max(0, applicable - counts.applied - needWork)
    const parts = [`手机适用 ${applicable} 条`]
    if (needWork === 0 && cannotUse === 0) parts.push('已全部生效')
    else {
      parts.push(`${counts.applied} 条已生效`)
      if (needWork > 0) parts.push(`${needWork} 条待处理`)
      if (cannotUse > 0) parts.push(`${cannotUse} 条手机端用不到`)
    }
    if (counts.noPkg > 0) parts.push(`另 ${counts.noPkg} 条桌面专属`)
    return parts.join(' · ')
  })()

  return {
    summary,
    tone: healthy ? 'good' : tone,
    enabled: snap.enabled ? '开' : '关',
    bytes: KB(snap.bytes || 0),
    variant: !snap.variant || snap.variant === DEFAULT_VARIANT ? '默认' : snap.variant,
    model: snap.last?.model || defaultModel(home) || '跟随引擎默认',
    patchText: reverted ? '未打' : `${counts.applied}/${applicable}`,
    patchCaption: caption,
    needText: need === 0 ? '没有要处理的' : `${need} 条要处理`,
    // 位置 / 强化段 / 探针 / 分类 / optIn 这些社区版特性收在一行里，
    // 不占 keyValue 的名额（那一栏是给最常看的五个数用的）。
    extras: [
      `位置 ${snap.injectPosition}`,
      `强化段 ${snap.boost ? '开' : '关'}`,
      snap.probe ? `探针 ${snap.probe.nonce}` : '探针 无',
      snap.categories ? `分类 ${snap.categories}` : '分类 关',
      optInPending ? `可选 ${optInPending} 条未打` : '',
    ].filter(Boolean).join(' · '),
    alert: !healthy,
    alertText: injectOff && patchOff
      ? '破甲未工作 · 点开修复'
      : injectOff
        ? '破甲已关 · 点开恢复'
        : '破甲异常 · 点开处理',
    tables,
    empty: tables.length === 0,
  }
}

/** 静态骨架：不碰文件、不算任何东西，只描述布局与绑定路径。 */
export function buildView() {
  return {
    v: 1,
    type: 'stack',
    title: '破甲状态',
    children: [
      { type: 'callout', tone: { $: 'data.tone' }, text: { $: 'data.summary' } },
      {
        type: 'metric',
        label: '补丁层',
        value: { $: 'data.patchText' },
        tone: { $: 'data.tone' },
        caption: { $: 'data.patchCaption' },
      },
      {
        type: 'keyValue',
        items: [
          ['注入', { $: 'data.enabled' }],
          ['正文', { $: 'data.bytes' }],
          ['变体', { $: 'data.variant' }],
          ['模型', { $: 'data.model' }],
          ['待办', { $: 'data.needText' }],
        ],
      },
      { type: 'text', text: { $: 'data.extras' }, tone: 'muted' },
      // 上限 4 个按钮：「应用补丁」被「一键注入」取代——后者连提示词一起开。
      { type: 'actions', items: [
        { label: '重读', action: 'refresh', icon: 'refresh', style: 'primary' },
        { label: '一键注入', action: 'oneClick', icon: 'bolt' },
        { label: '开关注入', action: 'toggle', icon: 'power' },
        { label: '还原补丁', action: 'patchRevert', icon: 'retry' },
      ] },
      { type: 'text', text: '明细', tone: 'muted' },
      { type: 'stack', children: { $: 'data.tables' } },
    ],
  }
}

/**
 * 注册面板与状态条。桥接不存在时（网页版、纯终端）静默跳过。
 *
 * 传进来的应当是**插件自己的 ctx**，不是 ctx.inject(['dshGo']) 的回调 ctx ——
 * 后者是个子 fiber 的上下文，桥接服务重建时会被整体销毁，连带把注册一起清掉。
 *
 * @param {any} ctx 插件自己的 ctx
 * @param {{ home: string, config: any, warn: (m: string) => void, diag?: Function }} deps
 * @returns {string[]} 注册到了哪些面
 */
export function installDshGo(ctx, deps) {
  const { home, config, warn } = deps
  // ctx.get(name, false) 是 cordis 里唯一「不声明 inject 也能拿服务」的口子。
  let go = null
  try {
    go = typeof ctx?.get === 'function' ? ctx.get('dshGo', false) : null
  } catch {
    go = null
  }
  if (!go || typeof go !== 'object') return []

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
    // 状态条只在异常时出现：正常就发空字符串，App 那边 text 为空会直接不画。
    for (const emit of [...stripEmitters]) {
      try {
        emit(data.alert ? { text: data.alertText, icon: 'warning', tone: 'warn' } : { text: '' })
      } catch { /* 状态条未显示 */ }
    }
  }

  if (typeof go.strip === 'function') {
    try {
      cleanups.push(go.strip(ALERT_ID, (scope, emit) => {
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
      registered.push(`strip:${ALERT_ID}`)
    } catch (error) {
      warn(`状态条注册失败：${error?.message || error}`)
    }
  }

  if (typeof go.panel === 'function') {
    try {
      cleanups.push(go.panel(PANEL_ID, {
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
          // 第五个动作留给斜杠命令用不到的场景：切 boost（尾段强化）。
          boost: () => {
            try {
              const now = !readTuning(home).boost
              writeTuning(home, { boost: now })
              push()
              return { toast: now ? '强化段已开' : '强化段已关' }
            } catch (error) {
              return { toast: `切换失败：${String(error?.message || error).slice(0, 24)}` }
            }
          },
        },
      }))
      registered.push(`panel:${PANEL_ID}`)
    } catch (error) {
      warn(`面板注册失败：${error?.message || error}`)
    }
  }

  registered.cleanups = cleanups
  // App 只要还在订阅状态条/面板，就说明注册活着（producer 是订阅时才调的）。
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
