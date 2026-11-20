// /purge 命令。手机上打字不方便，所以正文写入支持「从文件读」：/purge prompt set /sdcard/x.md
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import path from 'node:path'
import { dshHome, purgeDir, injectPath, isFile } from './home.js'
import { loadTable, probe, detectRoot, listPkgs, targetsFor, editsOf, isDone } from '../patches/lib/core.mjs'
import { readState, setEnabled } from './state.js'
import { snapshot, patchSnapshot, invalidatePatches } from './view.js'
import { patchAdvice } from './dshgo.js'
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
  patchApply,
  patchRevert,
  setBoost,
  setInjectPosition,
  setExtraPatches,
  probeNew,
  probeClear,
} from './ops.js'
import { listVariants, sanitizeName } from './prompt.js'
import { readTuning } from './community.js'

const HELP = [
  '/purge status · 现状（开关、来源、体积、变体、位置、补丁层）',
  '/purge on | off · 开关注入',
  '/purge apply [force] · 开启并确保正文存在',
  '/purge revert · 关闭并把正文备份到 dsh-purge/backups/',
  '/purge seed [force] · 重写包内默认正文到 prompt-inject.md',
  '/purge prompt show · 看正文前 1200 字',
  '/purge prompt set <文件> · 用文件的全文替换正文',
  '/purge prompt reset · 恢复包内默认正文',
  '/purge variant list · 列出变体',
  '/purge variant use <名字> · 切到某个变体',
  '/purge variant default · 回到默认变体',
  '/purge variant map <模型> <名字|-> · 按模型指定变体（- 取消）',
  '/purge cat list · 题材分类（含编号、别名、路由）',
  '/purge cat show <id> · 看一条分类的规则正文',
  '/purge cat on|off <id> · 单独开关一条分类',
  '/purge cat add <id> <别名,别名> <规则正文> [| 路由] · 加一条',
  '/purge cat rm <id> · 删一条（出厂项写墓碑，可 reset 复原）',
  '/purge cat reset · 丢掉覆盖层，回到包内出厂分类',
  '/purge cat bake · 把当前分类真正写进 prompt-inject.md',
  '/purge boost on|off · 尾部强化段',
  '/purge position head|tail|both · 注入位置',
  '/purge extra <id,id|-> · 默认关闭补丁的白名单',
  '/purge probe [new|clear] · 运行时探针（new 生成 nonce，回显即链路通）',
  '/purge patches [probe|apply|restore] · 补丁层（默认 probe）',
  '/purge env · 引擎包清单与打不上的目标路径（排障用）',
  '/purge diag · 原生界面诊断（桥接、注册、最近日志）',
  '/purge home · 相关路径',
].join('\n')

/** /purge cat 的输出：编号 · id · 别名 → 路由，关掉的打 x。 */
function categoryText(home) {
  const { all, entries, warnings } = categoryList(home)
  if (!all.length) return '没有任何题材分类。'
  const lines = [`题材分类：${entries.length}/${all.length} 生效`]
  for (const entry of all) {
    const mark = entry.enabled ? '·' : 'x'
    lines.push(`${mark} ${entry.n}. ${entry.id} · ${entry.labels.join('/')}${entry.route ? ` → ${entry.route}` : ''}`)
  }
  if (warnings.length) lines.push(`注意：${warnings.join('；')}`)
  return lines.join('\n')
}

function statusText(home, config) {
  const snap = snapshot(home, config)
  const lines = [
    `破甲：${snap.enabled ? '开' : '关'} · ${snap.bytes} 字节 / ${snap.chars} 字`,
    `来源：${snap.sourceLabel} · 变体：${snap.variant}${snap.last?.model ? ` · 模型：${snap.last.model}` : ''}`,
    `位置：${snap.injectPosition} · 强化段：${snap.boost ? '开' : '关'} · 探针：${snap.probe ? snap.probe.nonce : '无'}`,
    `分类：${snap.categories} 条 · 主文件：${snap.injectPath}${snap.injectExists ? '' : '（缺失）'}`,
  ]
  const byModel = Object.entries(snap.byModel || {})
  if (byModel.length) lines.push(`按模型：${byModel.map(([m, v]) => `${m}→${v}`).join(', ')}`)
  const dropped = snap.last?.dropped || []
  if (dropped.length) lines.push(`压掉的官方段：${dropped.join(', ')}`)
  const patch = patchSnapshot(config?.aiRoot)
  if (patch.ok) {
    const applied = Number(patch.tally.applied) || 0
    const pending = (patch.rows || []).filter((r) => ['hit', 'drifted'].includes(r.status)).length
    lines.push('')
    lines.push(`补丁层：${applied}/${patch.applicable} 手机适用条数已生效（表里共 ${patch.total} 条）`)
    lines.push(`  待打 ${pending} 条 · 桌面专属 ${patch.tally.no_pkg || 0} 条 · 引擎 ${patch.root}`)
    if (applied > 0 && applied < 10) lines.push('  ⚠ 低于 10 条即判定被 App 更新覆盖，说一句「重打补丁」')
  } else {
    lines.push('')
    lines.push(`补丁层：读不到（${patch.error || '未扫描'}）`)
  }
  return lines.join('\n')
}

function patchText(home, config) {
  const patch = patchSnapshot(config?.aiRoot)
  if (!patch.ok) return `补丁层读不到：${patch.error || '未扫描'}`
  const label = {
    applied: '已生效', partial: '部分命中', hit: '待应用', drifted: '被覆盖',
    miss: '未命中', no_needle: '无目标句', no_file: '文件缺失', no_pkg: '包不存在',
  }
  const lines = [
    `引擎：${patch.root}`,
    `手机适用 ${patch.applicable} 条 · 已生效 ${patch.tally.applied || 0} 条 · 表里共 ${patch.total} 条`,
  ]
  for (const st of ['hit', 'drifted', 'partial', 'miss', 'no_file', 'no_needle', 'no_pkg', 'applied']) {
    const list = (patch.rows || []).filter((r) => r.status === st)
    if (!list.length) continue
    lines.push('')
    lines.push(`# ${label[st]} ${list.length}`)
    for (const r of list.slice(0, 20)) lines.push(`  ${r.id}.${r.name} → ${patchAdvice(r)}`)
    if (list.length > 20) lines.push(`  …另有 ${list.length - 20} 条`)
  }
  return lines.join('\n')
}

function readPromptFile(file) {
  const path = String(file || '').trim()
  if (!path) throw new Error('用法：/purge prompt set <文件路径>')
  if (!isFile(path)) throw new Error(`读不到文件：${path}`)
  const body = readFileSync(path, 'utf8')
  if (!body.trim()) throw new Error('文件是空的')
  if (body.length > MAX_PROMPT_CHARS) throw new Error(`正文超过 ${MAX_PROMPT_CHARS} 字符`)
  return body
}

/** `/purge cat ...` 的解析：规则正文里可能有空格，路由用 ` | ` 隔开。 */
function runCategory(raw, home) {
  const input = String(raw || '').trim()
  const sep = input.match(/\s\|\s/)
  const head = sep ? input.slice(0, sep.index) : input
  const route = sep ? input.slice(sep.index + sep[0].length).trim() : ''
  const action = (head.trim().split(/\s+/)[0] || 'list').toLowerCase()
  const rest = head.trim().split(/\s+/).slice(1).filter(Boolean)

  if (action === 'list' || action === 'ls') return categoryText(home)
  if (action === 'show') {
    const id = (rest[0] || '').toLowerCase()
    const { all } = categoryList(home)
    const hit = all.find((entry) => entry.id === id)
    if (!hit) throw new Error(`没有这个分类：${rest[0] || '(空)'}`)
    return [`# ${hit.n} ${hit.id} · ${hit.enabled ? '生效' : '已关'}`, `别名：${hit.labels.join(' / ')}`, `路由：${hit.route || '(无)'}`, `来源：${hit.source}`, '', hit.rule].join('\n')
  }
  if (action === 'add' || action === 'set') {
    const id = rest[0]
    const labels = rest[1]
    const rule = rest.slice(2).join(' ')
    if (!id || !labels || !rule) throw new Error('用法：/purge cat add <id> <别名,别名> <规则正文> [| 路由]')
    const added = categoryAdd(home, { id, labels, rule, route })
    return `已加分类 ${added.entry.n}. ${added.entry.id}（${added.entry.labels.join('/')}）；共 ${added.entries.length} 条生效`
  }
  if (action === 'rm' || action === 'del' || action === 'remove') {
    const id = rest[0]
    if (!id) throw new Error('用法：/purge cat rm <id>')
    const result = categoryRemove(home, id)
    return result.removed ? `已删分类 ${id}；剩 ${result.entries.length} 条生效` : `本来就没有 ${id}`
  }
  if (action === 'on' || action === 'off') {
    const id = rest[0]
    if (!id) throw new Error(`用法：/purge cat ${action} <id>`)
    const result = categoryToggle(home, id, action === 'on')
    return `分类 ${id} 已${action === 'on' ? '开' : '关'}；共 ${result.entries.length} 条生效`
  }
  if (action === 'reset') {
    const list = categoryReset(home)
    return `覆盖层已清空，回到出厂分类（${list.entries.length} 条生效）`
  }
  if (action === 'bake') {
    const baked = categoryBake(home)
    return `已写入 ${baked.bytes} 字节 → ${baked.path}（${baked.categories} 条分类）`
  }
  throw new Error(`不认识的 cat 子命令：${action}（list|show|add|rm|on|off|reset|bake）`)
}

/**
 * @param {string} raw invocation.rawInput
 * @param {{ home: string, config: any }} deps
 * @returns {string}
 */
export function runPurge(raw, deps) {
  const { home, config } = deps
  const input = String(raw || '').trim()
  const [head, ...rest] = input.split(/\s+/).filter(Boolean)
  const sub = (head || 'status').toLowerCase()

  if (!head || sub === 'status') return statusText(home, config)
  if (sub === 'help' || sub === '?') return HELP

  if (sub === 'on' || sub === 'enable') {
    setEnabled(home, true)
    return `破甲已开启（${snapshot(home, config).bytes} 字节）`
  }
  if (sub === 'off' || sub === 'disable') {
    setEnabled(home, false)
    return '破甲已关闭'
  }
  if (sub === 'apply') {
    const seeded = seed(home, { force: rest[0] === 'force' })
    setEnabled(home, true)
    return `破甲已开启；${seeded.written ? '已写入包内默认正文' : '沿用现有正文'}（${seeded.bytes} 字节）`
  }
  if (sub === 'revert' || sub === 'rollback') {
    const result = revert(home)
    return result.backup ? `破甲已关闭，正文备份到 ${result.backup}` : '破甲已关闭（没有可备份的正文）'
  }
  if (sub === 'seed') {
    const result = seed(home, { force: rest[0] === 'force' })
    return result.written ? `已写入包内默认正文（${result.bytes} 字节）` : '已有正文，未覆盖（加 force 强制重写）'
  }

  if (sub === 'boost') {
    const value = (rest[0] || '').toLowerCase()
    if (!['on', 'off'].includes(value)) {
      return `强化段当前：${readTuning(home).boost ? '开' : '关'}（用法：/purge boost on|off）`
    }
    const on = setBoost(home, value === 'on')
    return `尾部强化段已${on ? '开' : '关'}（新会话生效）`
  }

  if (sub === 'position') {
    const value = (rest[0] || '').toLowerCase()
    if (!['head', 'tail', 'both'].includes(value)) {
      return `注入位置当前：${readTuning(home).injectPosition}（用法：/purge position head|tail|both）`
    }
    return `注入位置已设为 ${setInjectPosition(home, value)}（新会话生效）`
  }

  if (sub === 'extra') {
    const raw = (rest[0] || '').trim()
    const ids = !raw || raw === '-' ? [] : raw.split(/[,，\s]+/).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    const list = setExtraPatches(home, ids)
    return list.length ? `可选补丁白名单：${list.join(',')}（下次打补丁时一起打）` : '可选补丁白名单已清空'
  }

  if (sub === 'probe') {
    const action = (rest[0] || 'new').toLowerCase()
    if (action === 'clear' || action === 'off') {
      probeClear(home)
      return '探针已撤掉'
    }
    const probe = probeNew(home)
    return `探针已写入（30 分钟过期）。发一句任意对话，让模型原样回显：\n\n[${probe.nonce}]\n\n回显了 = 注入链路通。`
  }

  if (sub === 'patches' || sub === 'patch') {
    const action = (rest[0] || 'probe').toLowerCase()
    if (action === 'apply' || action === 'restore') {
      const result = action === 'apply' ? patchApply(home, { root: config?.aiRoot }) : patchRevert(home, { root: config?.aiRoot })
      invalidatePatches()
      if (action === 'apply') {
        return result.ok
          ? `补丁已打上 ${result.applied} 个文件。重启引擎才生效：am force-stop io.github.ccch1mneyyy.dsh_app`
          : `打补丁失败：${result.reason || '未知'}`
      }
      return result.ok ? `已还原 ${result.restored} 个文件` : `还原失败：${result.reason || '未知'}`
    }
    return patchText(home, config)
  }

  // 环境自检：把「打不上」的那几条的目标路径与命中情况一次列出来。
  // 面板上只能看到状态，看不到「这条到底在找哪个文件」，发这段文本就能定位。
  if (sub === 'env') {
    let root = ''
    try {
      root = detectRoot(config?.aiRoot)
    } catch (error) {
      return `找不到引擎包：${error?.message || error}`
    }
    const table = loadTable()
    const rows = probe(root, table)
    const pkgs = listPkgs(root)
    const pending = rows.filter((r) => ['hit', 'drifted', 'miss', 'no_file', 'no_needle'].includes(r.status))
    const lines = [
      `引擎 ${root}`,
      `版本 ${(() => { try { return JSON.parse(readFileSync(path.join(root, 'dsh-base', 'package.json'), 'utf8')).version } catch { return '未知' } })()}`,
      `包 ${pkgs.length} 个：${pkgs.slice(0, 30).join(' ')}${pkgs.length > 30 ? ' …' : ''}`,
      '',
      `待处理 ${pending.length} 条（把这一段整段发出来就能定位）`,
    ]
    for (const row of pending) {
      const patch = table.patches.find((p) => p.id === row.id)
      if (!patch) continue
      const edits = editsOf(patch)
      lines.push(`#${row.id} ${row.name} [${row.status}]${row.desktopOnly ? ' 桌面专属' : ''}`)
      for (const target of targetsFor(patch, table)) {
        const file = path.join(root, target.pkg, ...target.rel)
        let left = -1
        try {
          const text = readFileSync(file, 'utf8')
          left = edits.filter((e) => !isDone(e, text)).length
        } catch {
          left = -1
        }
        lines.push(`   ${target.pkg}/${target.rel.join('/')}  ${left < 0 ? '文件不存在' : `待打 ${left}/${edits.length}`}`)
      }
    }
    return lines.join('\n')
  }

  // 原生界面诊断：把桥接对象暴露了哪些方法、注册走到了哪一步、最近几条日志打出来。
  // 手机上没有 stderr，出问题只能靠这个：让用户把输出整段贴出来即可定位。
  if (sub === 'diag') {
    const logFile = path.join(purgeDir(home), 'native-diag.log')
    const lines = []
    lines.push(`DSH_HOME ${dshHome()}`)
    lines.push(`插件目录 ${path.join(home, 'dsh-go', 'plugins', 'dsh-purge-community-go')}`)
    lines.push(`原生目录存在 ${fs.existsSync(path.join(home, 'dsh-go', 'plugins', 'dsh-purge-community-go'))}`)
    lines.push(`诊断日志 ${logFile}（${fs.existsSync(logFile) ? fs.statSync(logFile).size + ' 字节' : '没有'}）`)
    if (fs.existsSync(logFile)) {
      const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-12)
      lines.push('', '最近 12 条：')
      for (const line of tail) lines.push(`  ${line}`)
    }
    return lines.join('\n')
  }

  if (sub === 'prompt') {
    const action = (rest[0] || 'show').toLowerCase()
    if (action === 'show') {
      const snap = snapshot(home, config)
      return `${snap.sourceLabel} · ${snap.bytes} 字节 / ${snap.chars} 字\n\n${snap.text.slice(0, 1200)}`
    }
    if (action === 'set') {
      const body = readPromptFile(rest[1])
      const written = setPrompt(home, body)
      return `已写入 ${written.bytes} 字节 → ${written.path}`
    }
    if (action === 'reset') {
      seed(home, { force: true })
      return `已恢复包内默认正文（${snapshot(home, config).bytes} 字节）`
    }
    throw new Error(`不认识的 prompt 子命令：${action}（show|set|reset）`)
  }

  if (sub === 'variant') {
    const action = (rest[0] || 'list').toLowerCase()
    if (action === 'list') {
      const variants = listVariants(home)
      const active = readState(home).variant
      if (!variants.length) return `还没有变体。把 .md 放进 ${purgeDir(home)}/prompts/ 即可。`
      return variants.map((v) => `${v.name === active ? '*' : ' '} ${v.name} · ${v.bytes} 字节`).join('\n')
    }
    if (action === 'use') {
      const used = useVariant(home, rest[1])
      return `已切到变体 ${used.variant}`
    }
    if (action === 'default') {
      resetVariant(home)
      return '已回到默认变体'
    }
    if (action === 'map') {
      // sanitizeName(undefined) 会返回 'default'，漏参数时不能当成成功。
      if (!rest[1]) throw new Error('用法：/purge variant map <模型名> <变体名|->')
      const model = sanitizeName(rest[1])
      const name = rest[2] === '-' ? '' : rest[2]
      if (name === undefined) throw new Error('用法：/purge variant map <模型名> <变体名|->')
      const mapped = mapModel(home, rest[1], name)
      return mapped.variant ? `模型 ${model} → 变体 ${mapped.variant}` : `已取消模型 ${model} 的指定`
    }
    throw new Error(`不认识的 variant 子命令：${action}（list|use|default|map）`)
  }

  if (sub === 'cat' || sub === 'category' || sub === 'categories') {
    return runCategory(input.replace(/^\S+\s*/, ''), home)
  }

  if (sub === 'home') {
    return [
      `DSH_HOME：${dshHome()}`,
      `状态：${purgeDir(home)}/state.json`,
      `开关：${purgeDir(home)}/tuning.json`,
      `变体：${purgeDir(home)}/prompts/`,
      `备份：${purgeDir(home)}/backups/`,
      `补丁备份：${purgeDir(home)}/patch-backup/`,
      `正文：${injectPath(home)}`,
    ].join('\n')
  }

  throw new Error(`不认识的子命令：${sub}（/purge help 看用法）`)
}

/**
 * @param {any} ctx 已经 inject(['commands']) 的 ctx
 * @param {{ home: string, config: any, warn: (message: string) => void }} deps
 */
export function registerCommands(ctx, deps) {
  const commands = ctx.commands
  if (!commands || typeof commands.register !== 'function') return false
  try {
    commands.register({
      name: 'purge',
      description: '破甲开关、正文与补丁：status / on / off / apply / revert / prompt / variant / cat / boost / position / extra / probe / patches',
      input: { hint: 'status | on | off | apply | revert | seed | prompt show|set|reset | variant list|use|default|map | cat list|show|add|rm|on|off|reset|bake | boost on|off | position head|tail|both | extra <ids> | probe [new|clear] | patches [probe|apply|restore] | env | diag | home' },
      handler: async (invocation) => {
        try {
          return { kind: 'success', text: runPurge(invocation?.rawInput, deps) }
        } catch (error) {
          return { kind: 'error', text: `[dsh-purge] ${error?.message || error}` }
        }
      },
    })
    return true
  } catch (error) {
    deps.warn(`命令 /purge 注册失败：${error?.message || error}`)
    return false
  }
}
