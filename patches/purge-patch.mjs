#!/usr/bin/env node
/**
 * purge-patch - probe / apply / restore 引擎源码补丁（dsh-go 版）。
 *
 *   node patches/purge-patch.mjs probe   [--root <node_modules/@deepseek-ai>] [--out <file>]
 *   node patches/purge-patch.mjs apply   [--root ...] [--backup <dir>] [--dry] [--all]
 *   node patches/purge-patch.mjs restore --backup <dir> [--root ...]
 *
 * 补丁表是 patches/patches.json：由 dsh-purge-community 的 88 条表导出，
 * 每条 edit 是精确字符串替换（少数是正则），改完立刻 node --check / JSON.parse，
 * 校验不过就整批回滚。
 *
 * 实现在 patches/lib/core.mjs：本文件只解析 argv、调用、打印。
 */
import fs from "node:fs";
import path from "node:path";
import * as core from "./lib/core.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] || "probe";
const flag = (n) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n) => argv.includes("--" + n);

function fail(msg) { console.error("error: " + msg); process.exit(1); }

let root;
try {
  root = core.detectRoot(flag("root"));
} catch (err) {
  fail(err.message);
}

const NL = String.fromCharCode(10);

if (cmd === "probe") {
  const table = core.loadTable();
  const rows = core.probe(root, table);
  const applicable = core.applicableOf(rows);
  const t = core.tally(rows);
  console.log("root: " + root);
  console.log("tally: " + JSON.stringify(t));
  console.log("applicable: " + applicable + "（去掉桌面专属与目标包不存在的）" );
  if (table.meta && table.meta.source) {
    console.log("table: " + table.meta.source + " v" + (table.meta.version || "?") + " · " + rows.length + " 条");
  }
  const NOTE = {
    partial:
      "  正常情况，不用担心，不影响破甲能力。" + NL +
      "  补丁表里每条都写了几套不同引擎版本的写法，你的引擎只会有其中一套；" + NL +
      "  命中那套就已经改好了，剩下的是别的版本和桌面版的备用分支。",
    miss:
      "  一条都对不上：引擎里这段代码已经改了样子，或这条只管桌面端。" + NL +
      "  不影响手机端的破甲能力。",
    hit: "  全部匹配，可以打（跑 apply）。",
    drifted: "  以前打过，被引擎升级/App 更新冲掉了，跑 apply 重打。",
    applied: "  已经打过了。",
    no_needle: "  补丁数据里 pattern 为空或不可用，数据残缺。",
    no_pkg: "  目标包在手机引擎里不存在，改的是手机上没装的代码。",
    no_file: "  目标包在，但文件路径不在（版本布局不同）。",
  };
  for (const st of ["hit", "drifted", "partial", "applied", "miss", "no_file", "no_needle", "no_pkg"]) {
    const g = rows.filter((r) => r.status === st);
    if (!g.length) continue;
    console.log(NL + "# " + st + " (" + g.length + ")");
    if (NOTE[st]) console.log(NOTE[st]);
    if (st === "applied") continue;
    for (const r of g) {
      const extra = st === "partial" && r.total ? "  (" + (r.total - r.hits) + "/" + r.total + " 套写法命中)" : "";
      console.log("  " + r.id + "." + r.name + (r.pkg ? "  [" + r.pkg + "]" : "") + extra);
    }
  }
  // --out 决定 probe 结果写到哪；install.sh --dry 会传临时目录。
  const out = flag("out") || path.join(process.cwd(), "patch-probe.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ root, applicable, tally: t, rows }, null, 1));
} else if (cmd === "apply") {
  // --all：连 opt-in 补丁（默认关闭的那些）一起打。
  const extraIds = has("all") ? core.loadTable().patches.map((p) => p.id) : [];
  let report;
  try {
    report = core.apply(root, { backupDir: flag("backup"), dry: has("dry"), extraIds });
  } catch (err) {
    fail(err.message);
  }
  for (const line of report.logs) console.log(line);
  if (report.errors.length) process.exitCode = 1;
} else if (cmd === "restore") {
  let report;
  try {
    report = core.restore(flag("backup"), { root });
  } catch (err) {
    fail(err.message);
  }
  for (const line of report.logs) console.log(line);
  if (report.errors.length) process.exitCode = 1;
} else {
  fail("unknown command: " + cmd + " (probe | apply | restore)");
}
