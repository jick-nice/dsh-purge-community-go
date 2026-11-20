# CHANGELOG

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
