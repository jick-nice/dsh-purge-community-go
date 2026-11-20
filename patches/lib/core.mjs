/**
 * core - 补丁层的纯函数实现（dsh-go 版）。
 *
 * 与 dsh-purge-go 的差别：补丁表不再是「包名 + lib/index.js」的单一约定，
 * 而是 community 版的 88 条表 —— 每条要改的文件用「文件键」引用，
 * 由 patches.json 里的 fileTargets 映射成 [{pkg, rel}]。
 * 这样 71 个文件键（含 nested 副本、cordis.patch.yml、lib/types/*.js、
 * 别的模型后端）都能落到正确路径上，而执行器仍然只有一份。
 *
 * 约定：
 *   - 不读 process.argv、不调 process.exit、不写 console。
 *   - 所有函数返回结构化结果，由调用方决定怎么展示。
 *   - 出错抛 Error。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

/** 包名别名：community 表里同一用途在桌面/手机上叫法不同。 */
export const ALIAS = {
  escalation: ["dsh-escalation", "dsh-permission-escalation", "dsh-tool-escalation", "dsh-sandbox"],
  "auto-review": ["dsh-experimental-auto-review", "dsh-auto-review"],
  "conversation-client": ["dsh-conversation-client", "dsh-client-ui-conversation", "dsh-client-ui-chat"],
  "web-app-lib": ["dsh-web-app"],
  "deliverables-prompt": ["dsh-deliverables", "dsh-deliverables-prompt", "dsh-client-ui-deliverables"],
  "deliverable-file-references": ["dsh-deliverable-file-references", "dsh-deliverables"],
  "hooks-claude-code": ["dsh-hooks-claude-code", "dsh-hook-claude-code"],
  "hooks-codex": ["dsh-hooks-codex", "dsh-hook-codex"],
  "session-format-v0": ["dsh-session-format-v0-to-v1", "dsh-session-format-v0"],
  "user-approval-code": ["dsh-user-approval"],
  "desktop-shell": ["dsh-desktop-shell"],
  "dsh-tools-pipeline": ["dsh-tools"],
  "dsh-tools-pipeline-types": ["dsh-tools"],
  "ptc-tool": ["dsh-tool-executor-ptc", "dsh-tools"],
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** patches.json 与本模块的相对位置：<pkg>/patches/lib/core.mjs → <pkg>/patches/patches.json */
export function resolvePatchesFile() {
  // 用 fileURLToPath 而不是 .pathname：路径里有空格/中文时后者不解码百分号。
  return path.join(HERE, "..", "patches.json");
}

/** 读补丁表。兼容「裸数组」与「{meta,fileTargets,patches}」两种形态。 */
export function loadTable(file) {
  const target = file || resolvePatchesFile();
  const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  if (Array.isArray(parsed)) return { meta: {}, fileTargets: {}, patches: parsed, file: target };
  return {
    meta: parsed.meta || {},
    fileTargets: parsed.fileTargets || {},
    patches: Array.isArray(parsed.patches) ? parsed.patches : [],
    file: target,
  };
}

/** 只要补丁数组（历史 API）。 */
export function loadPatches(file) {
  return loadTable(file).patches;
}

/** 找引擎包目录。显式参数 > 环境变量 > 常见安装位置 > npm 全局根。 */
export function detectRoot(explicit) {
  const fromArg = explicit || process.env.DSH_AI_ROOT;
  if (fromArg) return fromArg;
  const candidates = [
    "/opt/dsh/node_modules/@deepseek-ai",
    path.join(os.homedir(), ".npm-global/lib/node_modules/@deepseek-ai"),
    "/usr/local/lib/node_modules/@deepseek-ai",
    "/usr/lib/node_modules/@deepseek-ai",
  ];
  try {
    const g = execFileSync("npm", ["root", "-g"], { stdio: "pipe" }).toString().trim();
    candidates.push(path.join(g, "@deepseek-ai"));
  } catch { /* 没有 npm 也能跑 */ }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("cannot locate @deepseek-ai; pass --root <dir>");
}

export function listPkgs(root) {
  try {
    return fs.readdirSync(root).filter((n) => {
      try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
    });
  } catch {
    return [];
  }
}

/** 一条 patch 的候选目标：[{pkg, rel}]。 */
export function targetsFor(patch, table) {
  const tableTargets = (table && table.fileTargets) || {};
  const keys = Array.isArray(patch.file) ? patch.file : [patch.file];
  const out = [];
  const patchRel = Array.isArray(patch.rel)
    ? patch.rel
    : typeof patch.rel === "string" ? patch.rel.split("/").filter(Boolean) : null;
  for (const key of keys) {
    if (!key) continue;
    const list = tableTargets[key];
    if (Array.isArray(list) && list.length) {
      for (const entry of list) {
        const rel = patchRel && patchRel.length ? patchRel : entry.rel;
        out.push({ pkg: entry.pkg, rel: Array.isArray(rel) ? rel : String(rel).split("/").filter(Boolean) });
      }
      continue;
    }
    // 表里没有这个键：按 go 的老约定兜底（dsh-<key> + lib/index.js），
    // 包不存在时自然落到 no_pkg，不会误改别的文件。
    const base = String(key).replace(/_/g, "-");
    const pkgs = [base, `dsh-${base}`].concat(ALIAS[base] || []);
    for (const pkg of pkgs) {
      out.push({ pkg, rel: patchRel && patchRel.length ? patchRel : ["lib", "index.js"] });
    }
  }
  // 同一路径只留一份（别名列表可能重复）
  const seen = new Set();
  return out.filter((t) => {
    const k = `${t.pkg}\u0000${t.rel.join("/")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function fileOf(root, target) {
  return path.join(root, target.pkg, ...target.rel);
}

function pkgDirExists(root, target) {
  try {
    return fs.statSync(path.join(root, target.pkg)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 把 patches.json 的一条 replacement 转成内部 edit。
 * pattern 两种写法：字符串（字面量）/ {source, flags}（正则）。
 */
function toEdit(r) {
  if (!r || typeof r.replace !== "string") return null;
  const p = r.pattern;
  if (typeof p === "string" && p.length > 0) return { pat: p, rep: r.replace };
  if (p && typeof p === "object" && typeof p.source === "string" && p.source.length > 0) {
    const flags = typeof p.flags === "string" ? p.flags : "g";
    return { pat: p.source, rep: r.replace, re: { source: p.source, flags } };
  }
  return null;
}

export function isRegexEdit(e) {
  return Boolean(e && e.re && typeof e.re.source === "string");
}

function globalRegex(e) {
  const flags = e.re.flags.includes("g") ? e.re.flags : e.re.flags + "g";
  return new RegExp(e.re.source, flags);
}

export function countHits(e, text) {
  if (isRegexEdit(e)) {
    const m = text.match(globalRegex(e));
    return m ? m.length : 0;
  }
  return text.split(e.pat).length - 1;
}

export function editsOf(p) {
  const out = [];
  for (const r of p.replacements || []) {
    const e = toEdit(r);
    if (e) out.push(e);
  }
  if (Array.isArray(p.patterns) && typeof p.replace === "string") {
    for (const s of p.patterns) {
      const e = toEdit({ pattern: s, replace: p.replace });
      if (e) out.push(e);
    }
  }
  return out;
}

/** markers / marker / forbid 里任意一条命中就算「我们打的」。 */
export function marked(p, text) {
  const ms = [];
  if (Array.isArray(p.markers)) ms.push(...p.markers);
  if (Array.isArray(p.markersAny)) ms.push(...p.markersAny);
  if (typeof p.marker === "string") ms.push(p.marker);
  if (typeof p.forbid === "string") ms.push(p.forbid);
  else if (Array.isArray(p.forbid)) for (const f of p.forbid) if (typeof f === "string") ms.push(f);
  return ms.some((m) => typeof m === "string" && m.length > 3 && text.includes(m));
}

/** 这条 edit 是否已经落到文件里（替换型看 pattern 在不在，追加型看 rep 在不在）。 */
export function isDone(e, text) {
  const rep = e.rep || "";
  if (isRegexEdit(e)) return !new RegExp(e.re.source, e.re.flags).test(text);
  if (rep === e.pat) return true;
  if (rep !== "" && rep.includes(e.pat)) return text.includes(rep);
  return !text.includes(e.pat);
}

/** 这条 patch 是不是桌面专属（community 用 surfaces 标了 7 条）。 */
export function isDesktopOnly(p) {
  return Array.isArray(p.surfaces) && p.surfaces.includes("desktop");
}

const RANK = { hit: 4, drifted: 3, partial: 2, applied: 1, miss: 0, no_needle: 0 };

/**
 * 逐补丁扫盘判定。
 * status: applied | hit | partial | miss | drifted | no_needle | no_file | no_pkg
 */
export function probe(root, tableOrPatches) {
  const table = Array.isArray(tableOrPatches)
    ? { fileTargets: {}, patches: tableOrPatches }
    : tableOrPatches || loadTable();
  const tablePatches = table.patches || [];
  const rows = [];
  for (const p of tablePatches) {
    const targets = targetsFor(p, table);
    const edits = editsOf(p);
    const rowsPerFile = [];
    let anyPkg = false;
    for (const target of targets) {
      if (pkgDirExists(root, target)) anyPkg = true;
      const file = fileOf(root, target);
      let text;
      try {
        if (!fs.statSync(file).isFile()) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!edits.length) {
        rowsPerFile.push({ status: "no_needle", pkg: target.pkg, file });
        continue;
      }
      const hits = edits.filter((e) => !isDone(e, text)).length;
      const hasMarker = marked(p, text);
      let st;
      if (hits === 0) st = hasMarker ? "applied" : "miss";
      else if (hits === edits.length) st = hasMarker ? "drifted" : "hit";
      else st = "partial";
      rowsPerFile.push({ status: st, pkg: target.pkg, file, hits, total: edits.length, marker: hasMarker });
    }

    const base = {
      id: p.id,
      name: p.name,
      layer: p.layer,
      layer_en: p.layer_en,
      desc: p.desc,
      desktopOnly: isDesktopOnly(p),
      optIn: p.optIn === true,
      optional: p.optional === true,
    };

    if (!rowsPerFile.length) {
      // 一个文件都没命中：包在就是 no_file，包不在就是 no_pkg。
      const status = anyPkg ? "no_file" : "no_pkg";
      rows.push(Object.assign(base, { status, pkg: targets[0] ? targets[0].pkg : "" }));
      continue;
    }
    let top = rowsPerFile[0];
    for (const r of rowsPerFile) if ((RANK[r.status] ?? 0) > (RANK[top.status] ?? 0)) top = r;
    const allApplied = rowsPerFile.every((r) => r.status === "applied");
    rows.push(Object.assign(base, top, {
      status: allApplied ? "applied" : top.status,
      targets: rowsPerFile.length,
      files: rowsPerFile.map((r) => r.file),
    }));
  }
  return rows;
}

export function tally(rows) {
  const t = {};
  for (const r of rows) t[r.status] = (t[r.status] || 0) + 1;
  return t;
}

/** 手机适用的条数：桌面专属 + 目标包不存在 都不算。 */
export function applicableOf(rows) {
  return rows.filter((r) => !r.desktopOnly && r.status !== "no_pkg").length;
}

export function restoreScript(root) {
  const lines = [
    "#!/bin/sh",
    "set -e",
    'D="$(dirname "$0")"',
    'ROOT="${DSH_AI_ROOT:-${1:-' + root + '}}"',
    'if [ ! -d "$ROOT" ]; then',
    '  echo "engine package dir not found: $ROOT" >&2',
    '  echo "usage: DSH_AI_ROOT=/path/to/@deepseek-ai sh $0" >&2',
    "  exit 1",
    "fi",
    'cd "$D/files"',
    'find . -type f | while read -r f; do cp -f "$f" "$ROOT/$f"; done',
    'echo "restored into $ROOT"',
  ];
  return lines.join("\n") + "\n";
}

export function sha256(file) {
  try {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

/** 读引擎版本（优先 dsh-base）。读不到返回 null，不阻断流程。 */
export function engineVersion(root) {
  for (const n of ["dsh-base", "dsh-session", "dsh-agent-loop"]) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(root, n, "package.json"), "utf8")).version;
      if (typeof v === "string" && v) return v;
    } catch { /* 试下一个 */ }
  }
  return null;
}

export function engineInfo(root) {
  return { version: engineVersion(root) };
}

/** 惰性加载 yaml；拿不到返回 null（不硬依赖）。 */
let yamlModule;
function requireYaml() {
  if (yamlModule !== undefined) return yamlModule;
  try {
    yamlModule = createRequire(import.meta.url)("yaml");
  } catch {
    try {
      yamlModule = createRequire(path.join(os.homedir(), "noop.js"))("yaml");
    } catch {
      yamlModule = null;
    }
  }
  return yamlModule;
}

/** 校验改写后的文件。null = 通过；字符串 = 原因（以 UNVERIFIED 开头表示没校验）。 */
export function verifyFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    try {
      execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
      return null;
    } catch (error) {
      // 有些环境根本不允许再拉起子进程（受限沙箱 / proot 里 exec 被拦）。
      // 那是「没法校验」，不是「校验不通过」——不能因此把补丁整批回滚。
      const code = error?.code || error?.errno;
      if (code === "EPERM" || code === "EACCES" || code === "ENOENT" || code === "ENOSYS") {
        return "UNVERIFIED: 本机无法执行 node --check（" + code + "），该文件未被校验";
      }
      return "node --check 失败：" + String(error?.stderr || error?.message || error).slice(0, 200);
    }
  }
  if (ext === ".json") {
    try {
      JSON.parse(fs.readFileSync(file, "utf8"));
      return null;
    } catch (error) {
      return "JSON 解析失败：" + (error?.message || String(error));
    }
  }
  if (ext === ".yml" || ext === ".yaml") {
    const mod = requireYaml();
    if (!mod) return "UNVERIFIED: 本机拿不到 yaml 解析器，该文件未被校验";
    try {
      // dsh 的 patch 文件用 !!js 自定义标签，标准解析会报 unknown tag，先剔除再解析。
      const cleaned = fs.readFileSync(file, "utf8").replace(/!!js /g, "");
      mod.parse(cleaned);
      return null;
    } catch (error) {
      return "YAML 解析失败：" + (error?.message || String(error)).slice(0, 200);
    }
  }
  return null;
}

/**
 * 应用补丁（事务式：任一文件写失败/校验失败 → 已写的全部回滚）。
 * @returns {{backupDir:string|null, applied:number, failed:number, files:Array, logs:string[], errors:Array, rolledBack:boolean, rollbackFailed:boolean, rollbackMissed:Array}}
 */
export function apply(root, opts = {}) {
  const { backupDir, dry = false, cwd = process.cwd() } = opts;
  // 表可以是完整 {fileTargets, patches}、裸补丁数组，或一个文件路径。
  const table = opts.table
    ? opts.table
    : Array.isArray(opts.patches)
      ? { fileTargets: {}, patches: opts.patches }
      : loadTable(opts.tableFile);
  const rows = probe(root, table);
  const logs = [];
  const errors = [];
  const extraIds = Array.isArray(opts.extraIds) ? opts.extraIds.map(Number) : [];
  const byFile = new Map();

  for (const r of rows) {
    if (!["hit", "partial", "miss", "drifted"].includes(r.status)) continue;
    if (!r.files || !r.files.length) continue;
    const p = table.patches.find((x) => x.id === r.id);
    if (!p) continue;
    // optIn（默认关闭的补丁）只有被显式列进 extraPatches 才打。
    if (p.optIn === true && !extraIds.includes(Number(p.id))) {
      logs.push("skip " + r.id + " " + (r.name || "") + " :: opt-in，未在 extraPatches 里");
      continue;
    }
    // 单目标补丁套到多个候选文件时只取命中的那几个（r.files 已经是「文件在」的那些）
    const edits = editsOf(p);
    if (!edits.length) continue;
    for (const file of r.files) {
      if (!fs.existsSync(file)) continue;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file).push({ id: r.id, name: r.name, edits });
    }
  }

  if (!byFile.size) {
    logs.push("nothing to apply");
    return {
      backupDir: null, applied: 0, failed: 0, files: [], logs, errors,
      rolledBack: false, rollbackFailed: false, rollbackMissed: [],
    };
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const dir = backupDir || path.join(cwd, "backup-" + stamp);
  // 记引擎版本：还原时用它判断「这份备份是不是当前这版引擎的」。
  const manifest = { root, at: new Date().toISOString(), engine: engineInfo(root), files: [] };
  for (const file of byFile.keys()) {
    const rel = path.relative(root, file);
    if (!dry) {
      const dst = path.join(dir, "files", rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(file, dst);
      manifest.files.push({ rel, size: fs.statSync(dst).size, sha256: sha256(dst) });
    }
  }
  if (!dry) {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
    fs.writeFileSync(path.join(dir, "restore.sh"), restoreScript(root));
    fs.chmodSync(path.join(dir, "restore.sh"), 0o755);
  }

  let ok = 0;
  let bad = 0;
  let rolledBack = false;
  let rollbackFailed = false;
  const files = [];
  const dirty = [];
  const rollbackMissed = [];

  const restoreOne = (file, rel) => {
    try {
      const from = path.join(dir, "files", rel);
      if (!fs.existsSync(from)) throw new Error("备份里没有这个文件");
      fs.copyFileSync(from, file);
      return true;
    } catch (error) {
      const msg = error?.message || String(error);
      rollbackFailed = true;
      rollbackMissed.push({ rel, error: msg });
      errors.push({ rel, error: "回滚失败：" + msg });
      return false;
    }
  };

  for (const [file, jobs] of byFile) {
    const rel = path.relative(root, file);
    const ids = jobs.map((j) => j.id);

    if (dry) {
      const text0 = fs.readFileSync(file, "utf8");
      const real = jobs.filter((j) => {
        const p = table.patches.find((x) => x.id === j.id);
        if (!p) return false;
        return editsOf(p).some((e) =>
          isRegexEdit(e) ? new RegExp(e.re.source, e.re.flags).test(text0) : text0.includes(e.pat),
        );
      });
      if (!real.length) continue;
      logs.push("would edit " + rel + " :: " + real.map((j) => j.id).join(","));
      files.push({ rel, ids: real.map((j) => j.id), ok: null, dry: true });
      continue;
    }

    let text = fs.readFileSync(file, "utf8");
    const origText = text;
    // 迭代式：链式补丁（A 产生 B 的前提）要在一轮之后接上。
    let rounds = 0;
    for (; rounds < 5; rounds++) {
      const before = text;
      for (const j of jobs) {
        const p = table.patches.find((x) => x.id === j.id);
        if (!p) continue;
        for (const e of editsOf(p)) {
          if (isRegexEdit(e)) {
            const re = new RegExp(e.re.source, e.re.flags);
            const next = text.replace(re, e.rep);
            if (next !== text) text = next;
            continue;
          }
          if (!text.includes(e.pat) || isDone(e, text)) continue;
          const parts = text.split(e.pat);
          if (parts.length > 1) text = parts.join(e.rep);
        }
      }
      if (text === before) break;
    }
    if (rounds > 1) logs.push("iter " + rel + " :: " + rounds + " 轮收敛");

    try {
      // 原子写：先写临时文件再 rename，被中断不会留下截断的引擎文件。
      const tmp = file + ".purge-tmp-" + process.pid;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    } catch (error) {
      restoreOne(file, rel);
      for (const d of dirty) if (d.file !== file) restoreOne(d.file, d.rel);
      rolledBack = true;
      ok = 0;
      bad++;
      const msg = "写入失败：" + (error?.message || String(error));
      logs.push("FAIL " + rel + " :: " + msg);
      files.push({ rel, ids, ok: false, error: msg });
      errors.push({ rel, ids, error: msg, rolledBack: true });
      break;
    }

    dirty.push({ file, rel });
    const verifyError = verifyFile(file);
    const unverified = typeof verifyError === "string" && verifyError.startsWith("UNVERIFIED");
    if (unverified) logs.push("WARN " + rel + " :: " + verifyError);
    if (verifyError === null || unverified) {
      if (text === origText) {
        logs.push("skip " + rel + " :: 内容无变化");
        continue;
      }
      ok++;
      logs.push("ok   " + rel + " :: " + ids.join(","));
      files.push({ rel, ids, ok: true });
    } else {
      restoreOne(file, rel);
      for (const d of dirty) if (d.file !== file) restoreOne(d.file, d.rel);
      rolledBack = true;
      bad++;
      logs.push(
        rollbackFailed
          ? "FAIL(verify, ROLLBACK INCOMPLETE) " + rel + " :: " + verifyError
          : "FAIL(verify, all restored) " + rel + " :: " + verifyError,
      );
      files.push({ rel, ids, ok: false, error: verifyError });
      errors.push({ rel, ids, error: verifyError, rolledBack: true });
      ok = 0;
      break;
    }
  }

  if (rolledBack) {
    for (const f of files) {
      if (f.ok === true) {
        f.ok = false;
        f.rolledBack = true;
        f.error = f.error || "已随事务回滚";
      }
    }
  }
  if (rolledBack && rollbackFailed) {
    logs.push("\nROLLBACK INCOMPLETE: " + rollbackMissed.length + " file(s) could not be restored — 引擎可能处于部分补丁状态");
  } else if (rolledBack) {
    logs.push("\nrolled back: all files restored, nothing is left patched");
  }
  if (!dry) logs.push("\napplied " + ok + " file(s), failed " + bad + " - backup at " + dir);

  return {
    backupDir: dry ? null : dir,
    applied: ok,
    failed: bad,
    files,
    logs,
    errors,
    rolledBack,
    rollbackFailed,
    rollbackMissed,
  };
}

/** 从备份还原。 */
export function restore(backupDir, opts = {}) {
  if (!backupDir) throw new Error("restore needs a backup directory");
  const src = path.join(backupDir, "files");
  const logs = [];
  const errors = [];
  const files = [];
  if (!fs.existsSync(src)) throw new Error("no files/ in " + backupDir);

  const manifestPath = path.join(backupDir, "manifest.json");
  let manifest = null;
  try {
    if (fs.existsSync(manifestPath)) manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push({ error: "manifest 读取失败：" + (error?.message || String(error)) });
  }

  const root = opts.root || manifest?.root || detectRoot();
  const rootMismatch = Boolean(manifest?.root && opts.root && manifest.root !== opts.root);
  const warnings = [];
  if (rootMismatch) warnings.push(`备份来自 ${manifest.root}，本次还原到 ${opts.root}，路径不一致`);

  const currentVersion = engineVersion(root);
  const backupVersion = manifest?.engine?.version ?? null;
  const engineMismatch = Boolean(backupVersion && currentVersion && backupVersion !== currentVersion);
  if (engineMismatch) {
    errors.push({
      error: `备份来自引擎 ${backupVersion}，当前是 ${currentVersion}。这份备份不能用来还原——` +
        "先点「一键注入」重打一次，会生成当前版本的备份。",
    });
  } else if (backupVersion === null && manifest !== null) {
    warnings.push("这份备份是很早以前打的，没记引擎版本，无法确认是否匹配");
  }
  if (engineMismatch) {
    logs.push("REFUSED: engine version mismatch");
    return { restored: 0, files, logs, errors, warnings, root, rootMismatch, hasManifest: true, engineMismatch: true, backupVersion, currentVersion };
  }

  let n = 0;
  const restoreOne = (rel) => {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) {
      const msg = "备份缺文件，无法还原";
      logs.push("FAIL " + rel + ": " + msg);
      files.push({ rel, ok: false, error: msg });
      errors.push({ rel, error: msg });
      return;
    }
    try {
      // 先校验备份文件本身，再写进引擎包。
      const expect = manifest?.files?.find((f) => f.rel === rel)?.sha256;
      if (expect) {
        const srcHash = sha256(from);
        if (srcHash && srcHash !== expect) {
          const msg = "备份文件与 manifest 不符，未写入";
          logs.push("FAIL " + rel + ": " + msg);
          files.push({ rel, ok: false, error: msg });
          errors.push({ rel, error: msg });
          return;
        }
      }
      fs.copyFileSync(from, path.join(root, rel));
      if (expect) {
        const actual = sha256(path.join(root, rel));
        if (actual && actual !== expect) {
          const msg = "还原后哈希不符";
          logs.push("FAIL " + rel + ": " + msg);
          files.push({ rel, ok: false, error: msg });
          errors.push({ rel, error: msg });
          return;
        }
      }
      logs.push("restored " + rel);
      files.push({ rel, ok: true });
      n++;
    } catch (error) {
      const msg = error?.message ? error.message : String(error);
      logs.push("FAIL " + rel + ": " + msg);
      files.push({ rel, ok: false, error: msg });
      errors.push({ rel, error: msg });
    }
  };

  if (manifest && Array.isArray(manifest.files) && manifest.files.length) {
    const actualCount = countFiles(src);
    if (manifest.files.length !== actualCount) {
      errors.push({ error: `备份目录里有 ${actualCount} 个文件，manifest 记了 ${manifest.files.length} 个` });
    }
    for (const f of manifest.files) restoreOne(f.rel);
  } else {
    logs.push("（该备份没有 manifest.json，无法做完整性校验）");
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else restoreOne(path.relative(src, full));
      }
    };
    walk(src);
  }

  logs.push("\nrestored " + n + " file(s)");
  for (const w of warnings) logs.push("WARN " + w);
  return { restored: n, files, logs, errors, warnings, root, rootMismatch, hasManifest: Boolean(manifest), engineMismatch: false, backupVersion, currentVersion };
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else n++;
    }
  };
  try { walk(dir); } catch { /* 读不到按 0 算 */ }
  return n;
}
