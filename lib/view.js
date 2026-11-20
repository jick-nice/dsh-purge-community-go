// 视图与状态数据。面板的 view() 是静态骨架，真正的取数在这里（dshgo.js 调 collect）。
// tools.js 的工具卡也用它，所以两份数字永远同源。

import { dshHome, injectPath, fileBytes, isFile } from './home.js'
import { readState } from './state.js'
import { DEFAULT_VARIANT, listVariants, resolveInject } from './prompt.js'
import { lastAssembly } from './assemble.js'
import { readTuning, readProbe } from './community.js'
import { loadTable, probe, tally, detectRoot, applicableOf } from '../patches/lib/core.mjs'

const KB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)

const SOURCE_LABEL = {
  'prompt-inject.md': 'prompt-inject.md',
  builtin: '包内默认正文',
  variant: '变体',
  'variant:model': '变体（按模型）',
  off: '已关闭',
  empty: '空',
}

/**
 * 补丁层现场：走 patches/lib/core.mjs 的 probe() 实时扫盘，30 秒缓存。
 * 扫一次要读 88 条 × 每个目标文件，面板每帧都扫会卡，所以缓存；
 * 但缓存只影响「多久刷新一次」，数据始终来自真实读文件。
 */
const patchCache = new Map()

export function patchSnapshot(root) {
  const key = root || '(default)'
  const hit = patchCache.get(key)
  const now = Date.now()
  if (hit?.value && now - hit.at < 30_000) return hit.value
  let value
  try {
    const r = root || detectRoot()
    const table = loadTable()
    const rows = probe(r, table)
    value = {
      ok: true,
      root: r,
      rows,
      tally: tally(rows),
      total: rows.length,
      applicable: applicableOf(rows),
      table: table.meta || {},
      error: '',
    }
  } catch (error) {
    value = { ok: false, root: '', rows: [], tally: {}, total: 0, applicable: 0, table: {}, error: error?.message || String(error) }
    // 失败不缓存：一次瞬时读盘失败（App 更新窗口期）不该让面板连着 30 秒都报错
    patchCache.set(key, { at: 0, value: null })
    return value
  }
  patchCache.set(key, { at: now, value })
  return value
}

/** 预热补丁缓存：在后台定时器里调一次，之后打开面板直接命中缓存。 */
export function warmPatchCache(root) {
  try {
    patchSnapshot(root)
    return true
  } catch {
    return false
  }
}

/** 让下一次 patchSnapshot 重新扫盘（应用/还原之后调）。 */
export function invalidatePatches() {
  patchCache.clear()
}

/** 一次完整的现场快照（面板、状态条、工具都用它）。 */
export function snapshot(home = dshHome(), options = {}) {
  const state = readState(home)
  const inject = injectPath(home)
  const resolved = resolveInject(home, { state, maxBytes: options.maxPromptBytes })
  const last = lastAssembly()
  const tuning = readTuning(home)
  const probeInfo = readProbe(home)
  return {
    home,
    enabled: state.enabled !== false,
    variant: state.variant || DEFAULT_VARIANT,
    byModel: state.byModel || {},
    variants: listVariants(home),
    injectPath: inject,
    injectExists: isFile(inject),
    injectBytes: fileBytes(inject),
    text: resolved.text,
    bytes: resolved.bytes,
    chars: resolved.text.length,
    lines: resolved.text ? resolved.text.split('\n').length : 0,
    source: resolved.source,
    sourceLabel: SOURCE_LABEL[resolved.source] || resolved.source,
    truncated: resolved.truncated === true,
    categories: resolved.categories || 0,
    last,
    tuning,
    boost: tuning.boost === true,
    injectPosition: tuning.injectPosition,
    extraPatches: tuning.extraPatches,
    probe: probeInfo,
    // 注意：这里**不**调 patchSnapshot()。probe() 要扫 88 条的目标文件，
    // 放进 snapshot() 等于把补丁扫描塞进插件加载和状态条刷新路径，会卡住引擎。
  }
}

/** 状态条：≤24 字。 */
export function stripData(snap, locale) {
  const on = snap.enabled
  const head = locale === 'en' ? (on ? 'on' : 'off') : on ? '破甲 开' : '破甲 关'
  // 状态条硬上限 24 字：clip 会多出一个省略号，所以截 23 再补。
  const raw = `${head} · ${KB(snap.bytes)}${snap.variant !== DEFAULT_VARIANT ? ` · ${snap.variant}` : ''}`
  const text = raw.length <= 24 ? raw : raw.slice(0, 23) + '…'
  return { text, tone: on ? 'good' : 'muted' }
}

/** 破甲面板（非 dsh-go 宿主用的纯数据视图；dsh-go 上走 dshgo.js 的静态骨架）。 */
export function panelView(snap, caps, options = {}) {
  const locale = caps?.locale === 'en' ? 'en' : 'zh'
  const z = (zh, en) => (locale === 'en' ? en : zh)
  const dropped = Array.isArray(snap.last?.dropped) ? snap.last.dropped : []

  const children = [
    {
      type: 'row',
      children: [
        { type: 'metric', label: z('状态', 'State'), value: snap.enabled ? z('开', 'on') : z('关', 'off'), tone: snap.enabled ? 'good' : 'warn' },
        { type: 'metric', label: z('正文', 'Prompt'), value: KB(snap.bytes), caption: `${snap.chars} ${z('字', 'chars')}` },
      ],
    },
    {
      type: 'keyValue',
      items: [
        [z('来源', 'Source'), snap.sourceLabel],
        [z('变体', 'Variant'), snap.variant],
        [z('位置', 'Position'), snap.injectPosition],
        [z('强化段', 'Boost'), snap.boost ? z('开', 'on') : z('关', 'off')],
        [z('探针', 'Probe'), snap.probe ? snap.probe.nonce : z('无', 'none')],
        [z('模型', 'Model'), snap.last?.model || z('未记录', 'n/a')],
        [z('压掉的段', 'Dropped'), dropped.length ? clip(dropped.join(' · '), 60) : z('无', 'none')],
        [z('主文件', 'File'), snap.injectPath],
      ],
    },
  ]

  if (snap.truncated) {
    children.push({ type: 'callout', tone: 'warn', text: z('正文超过配置上限，已截断注入。', 'Prompt exceeded the configured cap and was truncated.') })
  }

  // ── 补丁层 ──────────────────────────────────────────────────────────
  const patch = patchSnapshot(options.aiRoot)
  if (patch && patch.ok) {
    const applied = patch.tally.applied || 0
    const applicable = patch.applicable || 0
    const pending = (patch.tally.hit || 0) + (patch.tally.partial || 0) + (patch.tally.drifted || 0)
    children.push({
      type: 'metric',
      label: z('补丁', 'Patches'),
      value: `${applied}/${applicable}`,
      tone: applied >= 10 ? 'good' : 'bad',
      caption: pending ? z(`${pending} 条待应用`, `${pending} pending`) : z('无待应用项', 'none pending'),
    })
    // 按状态分组，各出一张表；单表 50 行上限，超出明示。
    const order = [
      ['hit', '待应用', 'pending'],
      ['drifted', '被覆盖', 'drifted'],
      ['partial', '部分命中', 'partial'],
      ['miss', '未命中', 'miss'],
      ['applied', '已生效', 'on'],
      ['no_file', '目标文件缺失', 'file missing'],
      ['no_needle', '无目标句', 'no needle'],
      ['no_pkg', '桌面专属', 'desktop-only'],
    ]
    const groups = {}
    for (const r of patch.rows) (groups[r.status] = groups[r.status] || []).push(r)
    for (const [st, zh, en] of order) {
      const list = groups[st] || []
      if (!list.length) continue
      const shown = Math.min(list.length, 50)
      children.push({ type: 'text', text: `— ${z(zh, en)} ${list.length} —`, tone: 'muted' })
      children.push({
        type: 'table',
        columns: [z('ID', 'ID'), z('补丁', 'Patch'), z('状态', 'State')],
        rows: list.slice(0, shown).map((r) => [String(r.id), r.name || '-', r.status]),
      })
      if (list.length > shown) {
        children.push({ type: 'text', text: z(`仅显示前 ${shown} 条，另有 ${list.length - shown} 条`, `showing ${shown} of ${list.length}`), tone: 'muted' })
      }
    }
  } else if (patch && !patch.ok) {
    children.push({
      type: 'callout',
      tone: 'warn',
      text: z(`补丁层读取失败：${clip(patch.error, 80)}`, `Patch read failed: ${clip(patch.error, 80)}`),
    })
  }

  children.push({
    type: 'actions',
    items: [
      { label: snap.enabled ? z('关闭注入', 'Injection off') : z('开启注入', 'Injection on'), action: 'toggle', style: 'primary' },
      { label: z('重读正文', 'Reload prompt'), action: 'reload' },
      { label: z('应用补丁', 'Apply patches'), action: 'patchApply' },
      { label: z('还原补丁', 'Revert patches'), action: 'patchRevert' },
    ],
  })

  return { type: 'stack', v: 1, title: z('破甲', 'Purge'), children }
}

/** 提示词面板：看当前真正会注入的正文（截断到 1800 字，全文用「复制」）。 */
export function promptView(snap, caps) {
  const locale = caps?.locale === 'en' ? 'en' : 'zh'
  const z = (zh, en) => (locale === 'en' ? en : zh)
  const preview = clip(snap.text, 1800) || z('（当前没有正文）', '(no prompt)')
  return {
    type: 'stack',
    v: 1,
    title: z('提示词', 'Prompt'),
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: z('字节', 'Bytes'), value: snap.bytes },
          { type: 'metric', label: z('行数', 'Lines'), value: snap.lines },
          { type: 'metric', label: z('变体', 'Variant'), value: snap.variant },
        ],
      },
      { type: 'callout', tone: 'info', text: `${snap.sourceLabel} · ${snap.enabled ? z('正在注入', 'injected') : z('已关闭，不注入', 'off, not injected')}` },
      { type: 'text', text: preview },
      {
        type: 'actions',
        items: [
          { label: z('复制正文', 'Copy'), action: 'copy', style: 'primary' },
          { label: snap.enabled ? z('关闭', 'Turn off') : z('开启', 'Turn on'), action: 'toggle' },
          { label: z('落盘默认', 'Seed'), action: 'seed' },
          { label: z('关闭并备份', 'Off + backup'), action: 'revert' },
        ],
      },
    ],
  }
}

/** 工具卡（只读、≤8 KiB、只能用最稳的几个组件）。 */
export function statusCard(snap, locale) {
  const z = (zh, en) => (locale === 'en' ? en : zh)
  return {
    type: 'stack',
    v: 1,
    title: z('破甲状态', 'Purge status'),
    children: [
      {
        type: 'row',
        children: [
          { type: 'metric', label: z('状态', 'State'), value: snap.enabled ? z('开', 'on') : z('关', 'off'), tone: snap.enabled ? 'good' : 'warn' },
          { type: 'metric', label: z('正文', 'Prompt'), value: KB(snap.bytes) },
        ],
      },
      { type: 'callout', tone: snap.enabled ? 'good' : 'warn', text: `${snap.sourceLabel}${snap.variant !== DEFAULT_VARIANT ? ` · ${snap.variant}` : ''}` },
      {
        type: 'compare',
        items: [
          { title: z('当前', 'Now'), rows: [[z('模型', 'Model'), snap.last?.model || '—'], [z('位置', 'Position'), snap.injectPosition], [z('强化段', 'Boost'), snap.boost ? z('开', 'on') : z('关', 'off')]] },
          { title: z('文件', 'File'), rows: [[z('主文件', 'Main'), snap.injectExists ? KB(snap.injectBytes) : z('缺失', 'missing')], [z('变体数', 'Variants'), String(snap.variants.length)]] },
        ],
      },
    ],
  }
}

export function promptCard(snap, locale) {
  const z = (zh, en) => (locale === 'en' ? en : zh)
  return {
    type: 'stack',
    v: 1,
    title: z('提示词', 'Prompt'),
    children: [
      { type: 'metric', label: z('字节', 'Bytes'), value: snap.bytes, caption: `${snap.chars} ${z('字', 'chars')}` },
      { type: 'callout', tone: snap.enabled ? 'good' : 'muted', text: `${snap.sourceLabel} · ${snap.variant}` },
      { type: 'text', text: clip(snap.text, 500) || z('（空）', '(empty)') },
    ],
  }
}
