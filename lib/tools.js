// 工具：purge_status / purge_apply / purge_revert / purge_prompt / purge_category /
//       purge_patch_apply / purge_tuning / purge_probe
// 每个都挂一张 dsh-go 工具卡（没有桥接/App 时这张卡没人读，不影响调用）。
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { toolCard } from './card.js'
import { snapshot, statusCard, promptCard, patchSnapshot, invalidatePatches } from './view.js'
import { patchAdvice, classifyRows } from './dshgo.js'
import {
  revert,
  seed,
  setPrompt,
  useVariant,
  resetVariant,
  mapModel,
  MAX_PROMPT_CHARS,
  categoryList,
  categoryAdd,
  categoryRemove,
  categoryToggle,
  categoryReset,
  categoryBake,
  setBoost,
  setInjectPosition,
  setExtraPatches,
  probeNew,
  probeClear,
} from './ops.js'
import { setEnabled } from './state.js'

/** 包根（lib/ 的上一级），用来找 patches/purge-patch.mjs。 */
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 调 patches/purge-patch.mjs，返回 { code, stdout, stderr }。 */
function runPatchScript(mode) {
  const script = join(PKG_ROOT, 'patches', 'purge-patch.mjs')
  return new Promise((resolve) => {
    execFile(process.execPath, [script, mode], { cwd: PKG_ROOT, timeout: 120_000 }, (error, stdout, stderr) => {
      // execFile 超时/被杀时 error.code 是 null，不能用 ?? 0 把失败当成功
      const code = typeof error?.code === 'number' ? error.code : error ? 1 : 0
      const why = error?.killed ? `（${error.signal || 'killed'}，可能超时）` : ''
      resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || error?.message || '') + why })
    })
  })
}

const text = (body) => [{ type: 'text', text: body }]

/** 低于这个已生效条数就判定「补丁层被覆盖」。 */
const PATCH_BROKEN_THRESHOLD = 10

/** 补丁层快照：按状态分布。只在被调用时扫盘，带 30 秒缓存。 */
function patchInfo(root) {
  const p = patchSnapshot(root)
  const rows = Array.isArray(p.rows) ? p.rows : []
  const c = classifyRows(rows)
  // pending 只放「点一下能解决」的：待打、被升级冲掉。
  // miss / no_file 不是待办，它们是「这版引擎没有这段代码」——列进待办会让
  // 状态永远看起来不健康（面板和工具会互相矛盾，用户怎么点都消不掉）。
  const pending = rows
    .filter((r) => (r.status === 'hit' || r.status === 'drifted') && !r.optIn)
    .sort((a, b) => a.id - b.id)
    .map((r) => ({ id: r.id, name: r.name, status: r.status, pkg: String(r.pkg || ''), advice: patchAdvice(r) }))
  return {
    ok: Boolean(p.ok),
    root: String(p.root || ''),
    total: Number(p.total) || 0,
    tally: p.tally || {},
    // covered/actionable 才是「全绿」的口径：分母只放本机能打上的条数。
    covered: c.covered,
    actionable: c.actionable,
    pendingCount: c.pending,
    gapCount: c.gap,
    desktopCount: c.desktop,
    applicable: Number(p.applicable) || 0,
    table: p.table || {},
    error: String(p.error || ''),
    pending,
    gap: rows
      .filter((r) => ['miss', 'no_file', 'no_needle'].includes(r.status))
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: r.name, status: r.status, advice: patchAdvice(r) })),
    partials: rows
      .filter((r) => r.status === 'partial')
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ id: r.id, name: r.name, hits: Number(r.hits) || 0, total: Number(r.total) || 0 })),
    optInPending: rows
      .filter((r) => r.optIn && ['hit', 'drifted', 'miss', 'no_file'].includes(r.status))
      .map((r) => ({ id: r.id, name: r.name })),
  }
}

/** 一句话结论，固定措辞，不给模型自由发挥的空间。 */
function patchVerdict(patches) {
  const covered = Number(patches?.covered) || 0
  const actionable = Number(patches?.actionable) || 0
  const pending = Number(patches?.pendingCount) || 0
  const gap = Number(patches?.gapCount) || 0
  if (!actionable) return '补丁层未扫描到引擎目录，无法判断。'
  if (covered < PATCH_BROKEN_THRESHOLD) {
    return (
      `破甲补丁层没生效：本机适用 ${actionable} 条，当前只有 ${covered} 条生效。` +
      'App 更新会重装引擎包把它们冲掉，调 purge_patch_apply（或说一句「重打补丁」），打完要重启引擎。'
    )
  }
  if (pending > 0) {
    return (
      `破甲可用，但还有 ${pending} 条补丁没打上（本机适用 ${actionable} 条、已落地 ${covered} 条）。` +
      '调 purge_patch_apply 一次补齐，然后重启引擎。'
    )
  }
  const tail = gap > 0 ? `另有 ${gap} 条在这版引擎里没有对应代码，不影响破甲。` : ''
  return `破甲完全正常：本机适用 ${actionable} 条，全部 ${covered} 条已生效。${tail}`
}

/** 没打上的补丁 + 原因 + 怎么办，拼成一段给人看的文本。 */
function pendingSummary(patches) {
  const list = Array.isArray(patches?.pending) ? patches.pending : []
  const gapList = Array.isArray(patches?.gap) ? patches.gap : []
  const covered = Number(patches?.covered) || 0
  const actionable = Number(patches?.actionable) || 0
  const gap = Number(patches?.gapCount) || 0
  const out = []
  // 扫不到引擎包时不能说「没有待处理项」——那和面板上的「无法判定」自相矛盾。
  if (!actionable) {
    return `补丁层无法判定：${patches?.error || '没有扫描到引擎目录'}。先用 purge_patch_apply 的 probe 看一眼，或确认引擎装在 /opt/dsh。`
  }
  out.push(
    covered < PATCH_BROKEN_THRESHOLD
      ? `【结论】破甲补丁层没生效。本机适用 ${actionable} 条，当前只有 ${covered} 条生效。调 purge_patch_apply，打完重启引擎。`
      : list.length
        ? `【结论】破甲可用：本机适用 ${actionable} 条，已落地 ${covered} 条，还差 ${list.length} 条。调 purge_patch_apply 补齐。`
        : `【结论】破甲完全正常：本机适用 ${actionable} 条，全部 ${covered} 条已生效。`,
  )
  out.push('')
  if (list.length) {
    out.push('还差这几条（点「一键注入」或调 purge_patch_apply 即可补齐）：')
    for (const r of list) out.push(`${r.id}.${r.name}：${r.advice}`)
  } else {
    out.push('没有需要打的补丁了。')
  }
  if (gap > 0) {
    out.push('')
    out.push(
      `另有 ${gap} 条在这版引擎里没有对应代码（不影响破甲，不用管）：` +
        gapList.slice(0, 12).map((r) => `${r.id}.${r.name}`).join('、') +
        (gapList.length > 12 ? ` 等 ${gapList.length} 条` : ''),
    )
  }
  if (patches?.optInPending?.length) {
    out.push('')
    out.push(
      `还有 ${patches.optInPending.length} 条「默认关闭」的补丁没打（${patches.optInPending.map((r) => r.id + '.' + r.name).join('、')}）。` +
        '它们是可选强化，需要时才开：/purge extra <id,...>',
    )
  }
  return out.join('\n')
}

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    source: { type: 'string' },
    variant: { type: 'string' },
    model: { type: 'string' },
    variants: { type: 'number' },
    injectPath: { type: 'string' },
    injectExists: { type: 'boolean' },
    dropped: { type: 'array', items: { type: 'string' } },
    home: { type: 'string' },
    boost: { type: 'boolean' },
    injectPosition: { type: 'string' },
    probe: { type: 'string' },
    categories: { type: 'number' },
    summary: { type: 'string' },
    verdict: { type: 'string' },
    patches: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean' },
        root: { type: 'string' },
        total: { type: 'number' },
        applicable: { type: 'number' },
        tally: { type: 'object', additionalProperties: true },
        table: { type: 'object', additionalProperties: true },
        error: { type: 'string' },
      },
    },
  },
}

const APPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    enabled: { type: 'boolean' },
    written: { type: 'boolean' },
    bytes: { type: 'number' },
    message: { type: 'string' },
  },
}

const PROMPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    message: { type: 'string' },
    bytes: { type: 'number' },
    chars: { type: 'number' },
    variant: { type: 'string' },
    variants: { type: 'array', items: { type: 'string' } },
    preview: { type: 'string' },
    maxChars: { type: 'number' },
  },
}

const CATEGORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    count: { type: 'number' },
    entries: { type: 'array', items: { type: 'string' } },
    message: { type: 'string' },
  },
}

const TUNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    boost: { type: 'boolean' },
    injectPosition: { type: 'string' },
    extraPatches: { type: 'array', items: { type: 'number' } },
    message: { type: 'string' },
  },
}

const PROBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    nonce: { type: 'string' },
    expiresInMs: { type: 'number' },
    message: { type: 'string' },
  },
}

/**
 * @param {any} ctx 已经 inject(['tools']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function registerTools(ctx, deps) {
  const tools = ctx.tools
  if (!tools || typeof tools.register !== 'function') return 0
  const { home, config, warn } = deps
  const snap = () => snapshot(home, config)
  let count = 0

  const register = (definition) => {
    try {
      tools.register(definition)
      count += 1
    } catch (error) {
      // 同名工具（同机装了桌面版 dsh-purge）只警告，不拖垮整插件加载
      warn(`工具 ${definition.name} 注册失败：${error?.message || error}`)
    }
  }

  register({
    name: 'purge_status',
    description:
      '查看破甲两层状态。注入层：开关、正文来源与体积、变体、注入位置、强化段、探针、上次组装压掉哪些官方段。补丁层：引擎路径、88 条补丁里手机适用的生效数与状态分布，以及没生效的那几条为什么、该怎么办。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: STATUS_SCHEMA,
      render: (_args, value) => text(statusText({ ...snapshot(home, config), patches: value?.patches })),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const current = snap()
      const patches = patchInfo(config?.aiRoot)
      return {
        enabled: current.enabled,
        bytes: current.bytes,
        chars: current.chars,
        source: current.sourceLabel,
        variant: current.variant,
        model: current.last?.model || '',
        variants: current.variants.length,
        injectPath: current.injectPath,
        injectExists: current.injectExists,
        dropped: current.last?.dropped || [],
        home: current.home,
        boost: current.boost,
        injectPosition: current.injectPosition,
        probe: current.probe?.nonce || '',
        categories: current.categories,
        patches,
        summary: pendingSummary(patches),
        verdict: patchVerdict(patches),
      }
    },
  })

  register({
    name: 'purge_apply',
    description:
      '开启破甲（提示词注入）并确保 $DSH_HOME/prompt-inject.md 有正文（缺失时落盘包内默认正文；force=true 覆盖重写）。**不涉及补丁层**——要打补丁用 purge_patch_apply，或点输入框上方的胶囊。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { force: { type: 'boolean', description: '覆盖已有的 prompt-inject.md' } },
    },
    output: {
      schema: APPLY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const seeded = seed(home, { force: args?.force === true })
      setEnabled(home, true)
      const current = snap()
      return {
        ok: true,
        enabled: true,
        written: seeded.written,
        bytes: current.bytes,
        message: `破甲已开启。${seeded.written ? '已写入默认正文' : '沿用现有正文'}：${current.bytes} 字节。`,
      }
    },
  })

  register({
    name: 'purge_revert',
    description:
      '关闭破甲（提示词注入），并把当前 $DSH_HOME/prompt-inject.md 备份到 dsh-purge/backups/（正文本身保留）。**不涉及补丁层**——要还原补丁用 purge_patch_apply 的 restore。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: APPLY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute() {
      const result = revert(home)
      return {
        ok: true,
        enabled: false,
        written: false,
        bytes: snapshot(home, config).bytes,
        message: result.backup ? `破甲已关闭，正文已备份到 ${result.backup}。` : '破甲已关闭（当前没有正文可备份）。',
      }
    },
  })

  register({
    name: 'purge_prompt',
    description: `读取/写入注入正文与变体。action：show（看正文与来源）、set（写 prompt-inject.md，≤${MAX_PROMPT_CHARS} 字）、reset（重写包内默认正文）、use（切换变体）、default（回默认变体）、map（按模型指定变体）。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'set', 'reset', 'use', 'default', 'map'] },
        text: { type: 'string', description: 'action=set 时的正文' },
        name: { type: 'string', description: '变体名（不带 .md）；action=map 时为空表示取消该模型的指定' },
        model: { type: 'string', description: 'action=map 时的模型名' },
      },
      required: ['action'],
    },
    output: {
      schema: PROMPT_SCHEMA,
      render: (_args, value) => text(value.preview ? `${value.message}\n\n${value.preview}` : value.message),
      presentationMeta: toolCard(() => promptCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const action = String(args?.action || 'show')
      const current = () => snap()
      if (action === 'set') {
        const written = setPrompt(home, args?.text)
        const now = current()
        return { ok: true, action, message: `已写入正文：${written.bytes} 字节 → ${written.path}`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'reset') {
        seed(home, { force: true })
        const now = current()
        return { ok: true, action, message: `已重写包内默认正文：${now.bytes} 字节`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'use') {
        const used = useVariant(home, args?.name)
        const now = current()
        return { ok: true, action, message: `已切到变体 ${used.variant}（${now.bytes} 字节）`, bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'default') {
        resetVariant(home)
        const now = current()
        return { ok: true, action, message: '已回到默认变体', bytes: now.bytes, chars: now.chars, variant: now.variant, variants: now.variants.map((v) => v.name), preview: '', maxChars: MAX_PROMPT_CHARS }
      }
      if (action === 'map') {
        const mapped = mapModel(home, args?.model, args?.name)
        const now = current()
        return {
          ok: true,
          action,
          message: mapped.variant ? `已把模型 ${mapped.model} 指定到变体 ${mapped.variant}` : `已取消模型 ${mapped.model} 的指定`,
          bytes: now.bytes,
          chars: now.chars,
          variant: now.variant,
          variants: now.variants.map((v) => v.name),
          preview: '',
          maxChars: MAX_PROMPT_CHARS,
        }
      }
      const now = current()
      return {
        ok: true,
        action: 'show',
        message: `破甲${now.enabled ? '开' : '关'} · ${now.bytes} 字节 / ${now.chars} 字 · 来源 ${now.sourceLabel} · 变体 ${now.variant} · 位置 ${now.injectPosition}`,
        bytes: now.bytes,
        chars: now.chars,
        variant: now.variant,
        variants: now.variants.map((v) => v.name),
        preview: now.text.slice(0, 1200),
        maxChars: MAX_PROMPT_CHARS,
      }
    },
  })

  register({
    name: 'purge_category',
    description:
      '题材分类扩展层（Scoped Rules 26+ 与意图映射扩展行）。action：list（全部条目与生效状态）、add（加一条，需 id/别名/规则正文）、rm（删一条）、on/off（单条开关）、reset（清空覆盖层回出厂）、bake（把当前分类写进 prompt-inject.md）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'rm', 'on', 'off', 'reset', 'bake'] },
        id: { type: 'string', description: '分类 id（小写字母/数字/-/_）' },
        labels: { type: 'string', description: 'action=add 时的别名，逗号分隔' },
        rule: { type: 'string', description: 'action=add 时的规则正文（写进 Scoped Rules）' },
        route: { type: 'string', description: 'action=add 时的意图映射目标' },
      },
      required: ['action'],
    },
    output: {
      schema: CATEGORY_SCHEMA,
      render: (_args, value) => text(value.message),
      presentationMeta: toolCard(() => statusCard(snap()), { onError: warn }),
    },
    async execute(args) {
      const action = String(args?.action || 'list')
      const brief = (entries) =>
        entries.map((entry) => `${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`).join('\n')
      if (action === 'add') {
        const added = categoryAdd(home, { id: args?.id, labels: args?.labels, rule: args?.rule, route: args?.route })
        return {
          ok: true,
          action,
          count: added.entries.length,
          entries: added.entries.map((entry) => entry.id),
          message: `已加分类 ${added.entry.n}. ${added.entry.id}（${added.entry.labels.join('/')}）。\n当前 ${added.entries.length} 条生效：\n${brief(added.entries)}`,
        }
      }
      if (action === 'rm') {
        const removed = categoryRemove(home, args?.id)
        return {
          ok: true,
          action,
          count: removed.entries.length,
          entries: removed.entries.map((entry) => entry.id),
          message: removed.removed ? `已删分类 ${args?.id}，剩 ${removed.entries.length} 条生效。` : `没有这个分类：${args?.id}`,
        }
      }
      if (action === 'on' || action === 'off') {
        const toggled = categoryToggle(home, args?.id, action === 'on')
        return {
          ok: true,
          action,
          count: toggled.entries.length,
          entries: toggled.entries.map((entry) => entry.id),
          message: `分类 ${args?.id} 已${action === 'on' ? '开' : '关'}。\n当前 ${toggled.entries.length} 条生效：\n${brief(toggled.entries)}`,
        }
      }
      if (action === 'reset') {
        const list = categoryReset(home)
        return { ok: true, action, count: list.entries.length, entries: list.entries.map((entry) => entry.id), message: `覆盖层已清空，回到出厂分类（${list.entries.length} 条）。` }
      }
      if (action === 'bake') {
        const baked = categoryBake(home)
        return { ok: true, action, count: baked.categories, entries: [], message: `已把 ${baked.categories} 条分类写进正文：${baked.bytes} 字节 → ${baked.path}` }
      }
      const list = categoryList(home)
      return {
        ok: true,
        action: 'list',
        count: list.entries.length,
        entries: list.all.map((entry) => entry.id),
        message: `题材分类 ${list.entries.length}/${list.all.length} 生效：\n${list.all
          .map((entry) => `${entry.enabled ? '·' : 'x'} ${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`)
          .join('\n')}`,
      }
    },
  })

  register({
    name: 'purge_tuning',
    description:
      '社区版运行时开关（存 $DSH_HOME/dsh-purge/tuning.json，即时生效、不用重启）。action：show（当前值）、boost（尾部强化段 on/off）、position（注入位置 head/tail/both）、extra（默认关闭的补丁 id 白名单，逗号分隔，空串清空）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'boost', 'position', 'extra'] },
        value: { type: 'string', description: 'boost: on/off；position: head|tail|both；extra: 1,2 或空串' },
      },
      required: ['action'],
    },
    output: {
      schema: TUNING_SCHEMA,
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const action = String(args?.action || 'show')
      const now = () => snapshot(home, config)
      if (action === 'boost') {
        const on = !/^(off|false|0|no)$/i.test(String(args?.value || '').trim())
        const boost = setBoost(home, on)
        return { ok: true, boost, injectPosition: now().injectPosition, extraPatches: now().extraPatches, message: `尾部强化段已${boost ? '开' : '关'}。` }
      }
      if (action === 'position') {
        const position = setInjectPosition(home, String(args?.value || '').trim())
        return { ok: true, boost: now().boost, injectPosition: position, extraPatches: now().extraPatches, message: `注入位置已设为 ${position}（新会话生效）。` }
      }
      if (action === 'extra') {
        const raw = String(args?.value || '').trim()
        const ids = raw ? raw.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
        const extraPatches = setExtraPatches(home, ids)
        return {
          ok: true,
          boost: now().boost,
          injectPosition: now().injectPosition,
          extraPatches,
          message: extraPatches.length ? `可选补丁白名单：${extraPatches.join(',')}（下次打补丁时一起打）` : '可选补丁白名单已清空。',
        }
      }
      const s = now()
      return {
        ok: true,
        boost: s.boost,
        injectPosition: s.injectPosition,
        extraPatches: s.extraPatches,
        message: `强化段 ${s.boost ? '开' : '关'} · 注入位置 ${s.injectPosition} · 可选补丁 ${s.extraPatches.length ? s.extraPatches.join(',') : '无'}`,
      }
    },
  })

  register({
    name: 'purge_probe',
    description:
      '运行时探针：证明注入真的到达模型。action=new 生成一次性 nonce（30 分钟过期）并要求模型原样回显；action=clear 撤掉探针。回显了就说明注入链路通。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { action: { type: 'string', enum: ['new', 'clear'] } },
      required: ['action'],
    },
    output: {
      schema: PROBE_SCHEMA,
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      if (String(args?.action) === 'clear') {
        probeClear(home)
        return { ok: true, nonce: '', expiresInMs: 0, message: '探针已撤掉。' }
      }
      const probe = probeNew(home)
      return {
        ok: true,
        nonce: probe.nonce,
        expiresInMs: 30 * 60 * 1000,
        message: `探针已写入（30 分钟过期）。下面是让模型原样回显的那句：\n\n${probe.message}`,
      }
    },
  })

  register({
    name: 'purge_patch_apply',
    description:
      '重打或还原引擎补丁层（88 条表）。App 更新会重装引擎包、把补丁冲掉，这时用 apply 一条命令重打。打完需要重启引擎才生效。restore 走最近一次备份还原；probe 只看当前分布、不改文件。**apply 成功后，除了说重启，还要提醒用户：以后更新 App 会覆盖补丁层，到时候重跑一次 apply 就行。**',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['apply', 'restore', 'probe'],
          description: 'apply 打补丁（默认）/ restore 还原到上次备份 / probe 只看状态不动文件',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          mode: { type: 'string' },
          message: { type: 'string' },
          tail: { type: 'string' },
          restartRequired: { type: 'boolean' },
        },
      },
      render: (_args, value) => text(value.message + (value.tail ? `\n\n${value.tail}` : '')),
    },
    async execute(args) {
      const mode = ['apply', 'restore', 'probe'].includes(args?.mode) ? args.mode : 'apply'
      const { code, stdout, stderr } = await runPatchScript(mode)
      const ok = code === 0
      const lines = stdout.trim().split('\n').filter(Boolean)
      const tail = lines.slice(-4).join('\n')
      const head =
        mode === 'apply'
          ? ok ? '补丁已重打' : '打补丁失败'
          : mode === 'restore'
            ? ok ? '补丁已还原' : '还原失败'
            : ok ? '补丁分布（未改动）' : '扫描失败'
      const hint = mode === 'probe' ? '' : ok ? '\n重启引擎才生效：am force-stop io.github.ccch1mneyyy.dsh_app' : `\n${stderr.slice(0, 300)}`
      const warn =
        ok && mode === 'apply'
          ? '\n\n**把下面这句原话告诉用户**：以后更新 dsh-go App 会重装引擎包、把补丁层整个冲掉，' +
            '到时候重跑一次 apply 就行，插件和配置都不用重新装。'
          : ''
      invalidatePatches()
      return { ok, mode, message: `${head}${hint}${warn}`, tail, restartRequired: mode !== 'probe' && ok }
    },
  })

  return count
}

/** 工具卡里那段纯文本状态（模型读这份）。 */
function statusText(snap) {
  const lines = []
  const p = snap.patches || {}
  const applied = Number(p.tally?.applied) || 0
  if (p.ok && Number(p.applicable) > 0 && applied < PATCH_BROKEN_THRESHOLD) {
    lines.push('⚠️ 破甲异常：补丁层没生效', `  当前只有 ${applied}/${p.applicable} 条生效（低于 ${PATCH_BROKEN_THRESHOLD} 条就判定为被覆盖）`, '')
  }
  lines.push(
    '【注入层】',
    `  开关：${snap.enabled ? '开' : '关'}`,
    `  正文：${snap.bytes} 字节 / ${snap.chars} 字 · 来源 ${snap.sourceLabel}`,
    `  变体：${snap.variant}${snap.last?.model ? ` · 模型 ${snap.last.model}` : ''}`,
    `  位置：${snap.injectPosition} · 强化段 ${snap.boost ? '开' : '关'} · 探针 ${snap.probe ? snap.probe.nonce : '无'}`,
    `  主文件：${snap.injectPath}${snap.injectExists ? '' : '（缺失，将用包内默认正文）'}`,
    `  其它变体：${snap.variants.length ? snap.variants.map((v) => v.name).join(', ') : '无'}`,
  )
  const byModel = Object.entries(snap.byModel || {})
  if (byModel.length) lines.push(`  按模型指定：${byModel.map(([m, v]) => `${m}→${v}`).join(', ')}`)
  const dropped = snap.last?.dropped || []
  if (dropped.length) lines.push(`  上次组装压掉的官方段：${dropped.join(', ')}`)
  if (snap.truncated) lines.push('  注意：正文超过配置上限，已截断。')
  lines.push('')
  lines.push('【补丁层】')
  if (p.ok) {
    const t = p.tally || {}
    const label = {
      applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
      miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
    }
    const order = ['applied', 'partial', 'hit', 'drifted', 'miss', 'no_needle', 'no_file', 'no_pkg']
    lines.push(`  引擎：${p.root || '未知'}`)
    lines.push(`  合计：${applied}/${p.applicable || 0} 手机适用条数已生效（表里共 ${p.total || 0} 条）`)
    const parts = order.filter((k) => t[k]).map((k) => `${label[k]} ${t[k]}`)
    if (parts.length) lines.push(`  分布：${parts.join(' · ')}`)
    if (p.table?.source) lines.push(`  补丁表：${p.table.source} v${p.table.version || '?'}`)
  } else {
    lines.push(`  读不到：${p.error || '未扫描'}`)
  }
  return lines.join('\n')
}
