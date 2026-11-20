# CHANGELOG

## 1.0.3 — 诊断报告能直接拿走

1.0.2 的 `/purge diag` 只能看，手机上一段长文本不好复制。这一版：

- 报告同时写到 `~/.dsh/dsh-purge/diag-report.txt`，用手机的文件管理器就能取走
- 加了 `purge_diag` 工具（第九个），模型可以自己调完直接把结论念给你
- 报告里多了一段**清单 id 与代码 id 的比对**：App 里胶囊不显示，最常见的原因就是
  `package.json` 的 `dshGo.contributes` 与 `lib/` 注册的 id 对不上，这一行能一眼看出来
- 原生目录不存在时直接给修法（`sh install.sh`），而不是只报 false

---

## 1.0.2 — 排障入口

真机上「原生界面」诊断页报 `插件已停用或找不到 /runtime/purge-alert`，但那台机器的机器上没有 stderr、
也看不到桥接对象长什么样。这一版补两个只读命令：

- `/purge diag`：插件目录是否存在、诊断日志多大、最近 12 条注册记录（strip / panel 走了哪个位置、成功还是报错）
- `/purge env`：引擎版本、装了哪些包、打不上的每条补丁的目标路径与剩余命中数

两个命令都只读，不改任何状态。出问题时把输出整段贴出来就能定位，不用猜。

顺带把 `dist/` 从 git 里移出（只走 Release），并把 README 的版本号与补丁口径对齐真机读数。

---

## 1.0.1 — 面板与计数修正

修的是真机反馈里的两个问题。

### 待办口径：终于能全绿

之前把 `miss` / `no_file` 也算成「待处理」，于是 88 条里那 11 条（这版引擎根本没有对应代码或路径）
永远消不掉，面板一直挂在「12 条需要处理」。

现在分四类，互斥且穷尽：

| 类 | 含哪些状态 | 算不算问题 |
|---|---|---|
| 已落地 | `applied` + `partial` | 不用管 |
| 待打 | `hit` + `drifted`（opt-in 两条除外） | 点「一键注入」 |
| 这版引擎没有 | `miss` / `no_file` / `no_needle` | 不用管 |
| 桌面专属 | `no_pkg` | 不用管 |

分母只放本机可打条目（已落地 + 待打）。真机上 65+2 已落地、1 条被冲掉 → 显示 `67/68`，
点一次「一键注入」即 `68/68`，结论变成「一切正常」。

### 面板重做

- 顶部一行结论（颜色即健康度）
- 「补丁」与「注入」两个大数字并排
- 正文 / 变体 / 模型 三个关键值
- 四个动作，`一键注入` 是主按钮
- 明细只把「要动手」的逐条列出（最多 8 条），其余每个状态一行小结 —— 不再把 65 条已生效铺满屏幕

### 原生桥

- 状态条与面板在 `bridge` / `composer` / `runtime` / `ui` / `native` 五个位置探测，不再只认 `bridge.strip`
- 注册后主动调用 `bridge.refresh()`，让 App 重新拉清单（诊断页里「插件已停用或找不到 /runtime/purge-alert」就是缺这一步）
- 启动窗口补齐注册后，再挂 30 秒慢速巡检（最多 10 分钟），一旦 `isLive()` 为真即停

### 新增 `/purge env`

把引擎包清单与「打不上那几条」的目标路径、剩余命中数一次列出来，排障时直接整段贴出来即可。

---

## 1.0.0 — 首个 dsh-go 移植版

把社区维护版 `dsh-purge-community` 1.7.20 的破甲能力搬进 dsh-go 原生插件。

### 内容来自社区版

- **88 条补丁表**（`patches/patches.json`）：从 `lib/patches/*.mjs` 导出，RegExp 形态的 pattern 统一写成
  `{ source, flags }`；`markers` / `forbid` / `optional` / `surfaces` / `optIn` / `rel` 原样保留。
- **文件键映射**（`fileTargets`）：从社区版 `lib/core.js` 的 `targetFiles()` 抽出「文件键 → 包名 + 相对路径」，
  17 个源码里没法直接抽的键（预设、nested 副本、pi-ai 后端、Liangshen）用脚本内的 `FALLBACK_TARGETS` 补齐。
- **注入正文**：与社区版同一份明文，用本包自己的盐重新封装成 `lib/asset-table.json`。
- **运行时开关的语义**：`boost` 尾部强化段、`injectPosition`（head / tail / both）、运行时探针（30 分钟 TTL）、
  能力选用协议段、题材分类扩展层（Scoped Rules 26+）。
- **opt-in 闸门**：#18 / #19 默认不打，列进 `tuning.extraPatches`（`/purge extra 18,19`）才打。

### 形态来自 dsh-purge-go

- dsh-go 原生桥：输入框上方胶囊（`purge-status`）、破甲状态面板（`session.tab` / `chat.panel` / `features`）、
  异常时自动出现的状态条（`purge-alert`）。
- 面板四个按钮：重读 / 一键注入 / 开关注入 / 还原补丁；打补丁走 deferred（60 秒上限）。
- `system-prompt/assemble` waterfall：注入正文置边、`harness:identity` 与 persona 段压制、自有段保序。
- 补丁执行器（`patches/lib/core.mjs`）：探测 / 事务式应用 / manifest 哈希 / 引擎版本闸 / 还原；
  `.js` 走 `node --check`，起不了子进程的环境标 `UNVERIFIED` 而不是失败回滚。
- 八个工具与 `/purge` 命令；拒答续跑；变体与按模型指定；原子落盘。

### 刻意没搬

`client.js`（721 KB）、`packages/purge-panel`、asar 解包 / 换包、Windows 控制台、更新器（13 个模块）、
桌面预设与 Liangshen、红队演练台、`rewind` 增强、`continue-retry`（与 `recover.js` 冲突）。
逐条理由见 [docs/port-notes.md](docs/port-notes.md)。

### 已知限制

- 补丁改的是 `node_modules`：App 更新会重装引擎包，补丁全丢，之后要重跑 apply。
- 只对新会话完全生效（系统提示写进对话历史）。
- 只适配 DeepSeek（正文按 ChatML / DeepSeek 格式写的）。
- `partial` 不代表已生效；健康与否只看 `applied` 条数（低于 10 判定被覆盖）。
