// 动作层：面板、命令、工具三处共用同一套实现，避免三份行为分叉。
import { readFileSync } from 'node:fs'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupFile, injectPath, fileBytes, patchBackupRoot } from './home.js'
import { readState, setEnabled, setVariant, setModelVariant } from './state.js'
import { seedInject, writeInject, normalizeText, sanitizeName, listVariants, defaultPromptText } from './prompt.js'
import { loadCategories, applyCategories, addCategory, removeCategory, setCategoryEnabled, resetOverlay } from './categories.js'
import { readTuning, writeTuning, createProbe, clearProbe } from './community.js'
import { apply as patchApplyCore, restore as patchRestoreCore, detectRoot } from '../patches/lib/core.mjs'

/** 插件仓库根（lib/ 的上一级）。用来找 install.sh 留下的旧备份。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 正文硬上限（字符）：防止一次误粘贴把组装撑爆。 */
export const MAX_PROMPT_CHARS = 200_000

/**
 * 应用补丁。返回真实结果：errors 非空就是失败，调用方据实显示。
 * 不吞错、不猜成功。
 */
export function patchApply(home, opts = {}) {
  const root = opts.root || detectRoot()
  const tuning = readTuning(home)
  // 目录名精确到毫秒并带随机后缀：只到秒时同一秒内两次「一键注入」会复用同一个目录，
  // 把真正的原始文件覆盖成已打补丁的内容，之后「还原补丁」写回去等于没还原。
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const ms = String(now.getMilliseconds()).padStart(3, '0')
  const rand = Math.random().toString(36).slice(2, 6)
  const backupDir = join(patchBackupRoot(home), `${stamp}${ms}-${rand}`)
  const report = patchApplyCore(root, {
    backupDir,
    // optIn 补丁只有被显式列进 tuning.extraPatches 才打（--all 时调用方传 extraIds）。
    extraIds: Array.isArray(opts.extraIds) ? opts.extraIds : tuning.extraPatches,
  })
  const rolledBack = report.rolledBack === true
  const rollbackFailed = report.rollbackFailed === true
  // 三种失败分开说：① 没改成功但干净回滚 ② 改了但回滚也失败（最危险）③ 其他错误
  const ok = report.errors.length === 0 && !rolledBack && !rollbackFailed
  let reason = firstReason(report.errors)
  if (rollbackFailed) {
    const miss = (report.rollbackMissed || []).map((m) => m.rel).slice(0, 3).join('、')
    reason = `回滚未完成，${(report.rollbackMissed || []).length} 个文件仍是改后状态${miss ? '（' + miss + '）' : ''}`
  } else if (rolledBack && !reason) {
    reason = '校验未通过，已全部回滚'
  }
  // 一条都没打上时，backupDir 里只躺着「试过但没打上」的文件，写回去内容一样。
  // 这种空备份留着会把真正有用的「打补丁前」快照挤掉。
  if (report.applied === 0 && report.backupDir) {
    try {
      rmSync(report.backupDir, { recursive: true, force: true })
      report.backupDir = ''
    } catch {
      /* 删不掉就算了 */
    }
  }
  return {
    ok,
    applied: report.applied,
    failed: report.failed,
    rolledBack,
    rollbackFailed,
    rollbackMissed: report.rollbackMissed || [],
    backupDir: report.backupDir || '',
    errors: report.errors,
    logs: report.logs,
    reason,
  }
}

/** 把 errors 数组压成一句人能读的原因。 */
function firstReason(errors) {
  if (!Array.isArray(errors) || !errors.length) return ''
  const e = errors[0]
  const where = e.rel ? e.rel + '：' : ''
  return where + (e.error || '未知错误')
}

/**
 * 还原补丁：找最近一次备份目录，跑 restore。
 * 两个来源都看：插件自己建的 patch-backup/，以及 install.sh 用 CLI 打的 backup-<stamp>/。
 */
export function patchRevert(home, opts = {}) {
  const candidates = []
  const base = patchBackupRoot(home)
  if (existsSync(base)) {
    for (const n of readdirSync(base)) {
      try {
        if (statSync(join(base, n, 'files')).isDirectory()) candidates.push({ name: n, dir: join(base, n) })
      } catch {
        /* 不是备份目录 */
      }
    }
  }
  try {
    for (const n of readdirSync(REPO_ROOT)) {
      if (!/^backup-/.test(n)) continue
      const dir = join(REPO_ROOT, n)
      try {
        if (statSync(join(dir, 'files')).isDirectory()) candidates.push({ name: n.replace(/^backup-/, ''), dir })
      } catch {
        /* 跳过 */
      }
    }
  } catch {
    /* 读不到仓库目录就只用 patch-backup */
  }
  if (!candidates.length) {
    return { ok: false, restored: 0, errors: [{ error: '没有可还原的补丁备份' }], backupDir: '' }
  }
  // 按 manifest 里的真实时间排序，不按目录名：目录名有 UTC 和本地两种口径。
  const atOf = (c) => {
    try {
      const m = JSON.parse(readFileSync(join(c.dir, 'manifest.json'), 'utf8'))
      return typeof m?.at === 'string' ? m.at : ''
    } catch {
      return ''
    }
  }
  for (const c of candidates) c.at = atOf(c)
  candidates.sort((a, b) => {
    if (a.at && b.at) return a.at < b.at ? -1 : a.at > b.at ? 1 : 0
    if (a.at) return 1
    if (b.at) return -1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  const latest = candidates[candidates.length - 1].dir
  const report = patchRestoreCore(latest, { root: opts.root || detectRoot() })
  // restored === 0 不能算成功：一个文件都没还原，说明备份空或全失败。
  const ok = report.errors.length === 0 && report.restored > 0
  let reason = firstReason(report.errors)
  if (!reason && report.restored === 0) reason = '一个文件都没还原（备份可能为空）'
  return {
    ok,
    restored: report.restored,
    errors: report.errors,
    backupDir: latest,
    rootMismatch: report.rootMismatch === true,
    hasManifest: report.hasManifest === true,
    reason,
  }
}

export function toggle(home) {
  const next = !readState(home).enabled
  setEnabled(home, next)
  return { enabled: next }
}

/** 关掉注入，顺便把当前 prompt-inject.md 备份一份，方便反悔。 */
export function revert(home) {
  const backup = backupFile(home, injectPath(home))
  setEnabled(home, false)
  return { enabled: false, backup }
}

export function seed(home, opts = {}) {
  const result = seedInject(home, { force: opts.force === true })
  return { written: result.written, path: result.path, bytes: result.bytes }
}

export function setPrompt(home, text) {
  const body = normalizeText(text)
  if (!body) throw new Error('正文为空')
  if (body.length > MAX_PROMPT_CHARS) throw new Error(`正文超过 ${MAX_PROMPT_CHARS} 字符上限`)
  const written = writeInject(home, body)
  return { bytes: written.bytes, path: written.path }
}

export function useVariant(home, name) {
  const key = sanitizeName(name)
  const known = listVariants(home).some((variant) => variant.name === key)
  if (!known) throw new Error(`没有变体 ${key}（dsh-purge/prompts/${key}.md）`)
  setVariant(home, key)
  return { variant: key }
}

export function resetVariant(home) {
  setVariant(home, 'default')
  return { variant: 'default' }
}

export function mapModel(home, model, name) {
  const modelKey = sanitizeName(model)
  if (!modelKey) throw new Error('模型名为空')
  if (!name || name === 'default') {
    setModelVariant(home, modelKey, '')
    return { model: modelKey, variant: '' }
  }
  const key = sanitizeName(name)
  const known = listVariants(home).some((variant) => variant.name === key)
  if (!known) throw new Error(`没有变体 ${key}`)
  setModelVariant(home, modelKey, key)
  return { model: modelKey, variant: key }
}

/** 复制用：复制通道上限 8000 字。 */
export function copyText(snap) {
  const limit = 7990
  if (snap.text.length <= limit) return { text: snap.text, truncated: false }
  return { text: snap.text.slice(0, limit), truncated: true }
}

export function injectSize(home) {
  return fileBytes(injectPath(home))
}

// ── 社区版带来的运行时开关 ──────────────────────────────────────

/** 尾部强化段开关。 */
export function setBoost(home, enabled) {
  return writeTuning(home, { boost: Boolean(enabled) }).boost === true
}

/** 注入位置：head | tail | both。 */
export function setInjectPosition(home, position) {
  if (!['head', 'tail', 'both'].includes(position)) throw new Error(`injectPosition 只能是 head / tail / both：${position}`)
  return writeTuning(home, { injectPosition: position }).injectPosition
}

/** 默认关闭（optIn）的补丁白名单。 */
export function setExtraPatches(home, ids) {
  return writeTuning(home, { extraPatches: Array.isArray(ids) ? ids : [] }).extraPatches
}

/** 运行时探针：写 nonce，30 分钟过期。 */
export function probeNew(home) {
  return createProbe(home)
}

export function probeClear(home) {
  return clearProbe(home)
}

// ── 题材分类扩展层 ──────────────────────────────────────────────

export function categoryList(home) {
  const loaded = loadCategories(home)
  return { entries: loaded.entries, all: loaded.all, warnings: loaded.warnings, maxN: loaded.maxN }
}

export function categoryAdd(home, payload) {
  return addCategory(home, payload)
}

export function categoryRemove(home, id) {
  return removeCategory(home, id)
}

export function categoryToggle(home, id, enabled) {
  return setCategoryEnabled(home, id, enabled)
}

export function categoryReset(home) {
  resetOverlay(home)
  return categoryList(home)
}

/** 把当前分类真正写进 prompt-inject.md（之后即使关掉扩展层，正文里也留着）。 */
export function categoryBake(home) {
  const entries = loadCategories(home).entries
  const current = normalizeText(readInjectText(home)) || normalizeText(defaultPromptText())
  if (!current) throw new Error('没有可写的正文')
  const baked = applyCategories(current, entries)
  if (baked.length > MAX_PROMPT_CHARS) throw new Error(`写入后超过 ${MAX_PROMPT_CHARS} 字符上限`)
  const written = writeInject(home, baked)
  return { bytes: written.bytes, path: written.path, categories: entries.length }
}

function readInjectText(home) {
  try {
    return readFileSync(injectPath(home), 'utf8')
  } catch {
    return ''
  }
}
