# 移植说明：dsh-purge-community → dsh-go

这份文档记录「搬了什么、怎么搬、什么没搬、为什么」。
面向想继续维护这个包的人，不是使用说明（使用看 [README.md](../README.md)）。

两个上游：

- **内容**：`dsh-purge-community` 1.7.20（MIT）——88 条补丁表、注入正文、运行时开关语义
- **形态**：`dsh-purge-go` 0.5.6（AGPL-3.0）——dsh-go 原生桥、组装 waterfall、补丁执行器

---

## 1. 为什么不能直接装社区版

社区版是**桌面版 DSH** 的插件，直接装到 dsh-go 上会在三个地方断：

| 断点 | 社区版的做法 | dsh-go 上会怎样 |
|---|---|---|
| 补丁目标定位 | `targetFiles(aiBase)` 返回**绝对路径表**，含 `resources/app`、`profiles/<name>/cordis.patch.yml`、`dsh/node_modules/...` 嵌套副本、桌面预设 yml | 路径全对不上，绝大多数补丁落成 `no_file` / `miss` |
| 界面 | Web slot（`packages/purge-panel`，浏览器里的 `127.0.0.1:3080`） | dsh-go 是 Flutter 原生界面，**不加载 Web client 模块** → 面板永远不出现 |
| 宿主对象 | `app.asar`、Electron 主进程、`schtasks`、官方更新器 | Android proot 里一个 node 进程，这些对象不存在 |

所以做法不是「改几行」，而是：**把内容搬出来，接到 dsh-go 的官方扩展点上**。

---

## 2. 逐模块映射

### 2.1 注入层

| 社区版 | 本包 | 说明 |
|---|---|---|
| `lib/index.js` 的 `registerPromptSections` | `lib/index.js` + `lib/assemble.js` | 段注册保留（head / tail / 能力协议 / boost / 探针 / post），段的重排改由 `system-prompt/assemble` waterfall 做，不依赖宿主是否按 order 排序 |
| `lib/identity.js`（43 KB，`installAssembleGuard` + slot 复用 + 400ms 自愈） | `lib/assemble.js` 的 `rewriteAssembly` | 手机上只有一个宿主实例、没有 Web 端热重载，那套自愈机制没有落点；waterfall 里直接「自有段置边 + 冲突段丢弃」已经足够，且不依赖任何引擎内部对象 |
| `lib/rules.js`（工作区规则、cwd 注入、prompt 审批） | `lib/prompt.js` 的解析优先级 | 只保留「byModel 变体 > 当前变体 > prompt-inject.md > 包内正文」，去掉 cwd 相关规则（手机上 cwd 就是 App 的私有目录，没有「多工作区」这一层） |
| `lib/asset-table.js`（AES-256-GCM + deflate，其自己的盐） | `lib/asset-table.json` + `lib/table-key.js` + `lib/table-read.js` | **同一份明文**，用本包自己的盐重新封装（`scripts/reseal-prompt.mjs`）。换盐的理由：两包若同时装，正文不该共用同一份密文 |
| `lib/boost.js` + `tuning.js` 的 `boost` | `lib/community.js` 的 `BOOST_TEXT` / `readBoost` / `writeBoost` | 保留正文与语义；状态统一收进 `tuning.json` |
| `lib/probe.js` | `lib/community.js` 的探针部分 | 保留 nonce、30 分钟 TTL、段落文本 |
| `lib/capability-protocol.js` | `lib/capability.js` | 只保留通用协议段；红队 lead/child 两段不搬（本包不带红队） |
| `lib/refusal-retry.js`（`llm/stream` 钩子，重试请求） | `lib/recover.js`（来自 dsh-go） | 社区版是「拦流、重试」；手机上更轻的做法是「一轮结束后追一句」，不重发请求、不猜错误码，按 seq 去重 |
| `lib/continue-retry.js` | 不搬 | 与 `recover.js` 解决同一件事，两者同时存在会互相打断 |
| `lib/rewind.js`（23 KB 增强回退） | 不搬，只留补丁 #56 #58 #75 #77 | 回退是数据一致性操作，按桌面会话结构写的实现在手机上风险高于收益 |

### 2.2 补丁层

| 社区版 | 本包 | 说明 |
|---|---|---|
| `lib/patches/{prompt,code,engine,new-tools,opt-in,stability}.mjs`（`ALL_PATCHES`，88 条） | `patches/patches.json` | 由 `scripts/export-community-patches.mjs` 导出：RegExp → `{source, flags}`，字段白名单原样保留（`markers` / `forbid` / `optional` / `surfaces` / `optIn` / `rel`） |
| `lib/core.js` 的 `targetFiles(aiBase)` | `patches.json` 的 `fileTargets` | 用文本解析从 `targetFiles()` 抽出 `path.join(aiBase, pkg, ...rel)` 与 `nestedPkg(...)`；预设 / Liangshen / pi-ai 等 17 个键用 `FALLBACK_TARGETS` 补齐（见下） |
| `lib/core.js` 的 `applyPatches` / `revertAll` / `backupAll`（含 asar 换包、shim 打补丁、桌面重启） | `patches/lib/core.mjs` + `patches/purge-patch.mjs` | 只保留「探测 / 事务式应用 / 备份 manifest / 还原 / node --check 校验」，去掉 asar、shim、计划任务、桌面重启 |
| `lib/anchors.js`（锚点漂移 + `reanchor` 半自动重锚） | 不搬 | 手机端面板只给状态与建议；漂移由「重打 / 看明细」处理。需要精修时用 `node patches/purge-patch.mjs probe` 的输出 |
| `lib/patch-state.mjs` / `lib/theme*` | 不搬 | 面板是 dsh-go 原生桥，不用社区版的 Web 计数模型 |

**`FALLBACK_TARGETS` 处理的那 17 个键**：

| 键 | 在手机上落到哪 | 扫描结果 |
|---|---|---|
| `preset-standard` / `ptc` / `cordis` / `minimal` / `unrestricted` | `dsh-agent-presets/presets/<名>/agent.cordis.yml`、`dsh-web-app/presets/<名>.patch.yml` | 一般 `no_pkg` / `no_file`（手机只跑 `dsh-base`） |
| `agent-preset` | 同上（standard） | 同上 |
| `desktop-shell` | `dsh-desktop-shell/lib/index.js` | `no_pkg` |
| `preset-liangshen` / `preset-liangshen-pkg` / `liangshen-tool-bootstrap` | 用户目录 / 第三方包 | 空目标 → `no_pkg`（桌面专属） |
| `system-prompt-nested` / `tool-web-nested` / `hooks-*-nested` | `dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js` | npm 嵌套布局才命中 |
| `pi-ai-anthropic-messages` / `completions` / `responses-shared` | `../@earendil-works/pi-ai/dist/api/*.js` | 手机只连 DeepSeek，通常 `no_pkg` |

### 2.3 宿主适配（全部丢弃）

| 模块 | 体积 | 为什么丢 |
|---|---|---|
| `client.js` | 721 KB | 依赖 `window.__ModuleLoader__` / Web slot，引擎 node 进程里没有 `window` |
| `packages/purge-panel/` | 独立包 | 浏览器里才加载，dsh-go 不加载 Web client |
| `lib/extract-asar.js` / `windows-asar-handoff.js` / `macos-asar-handoff.js` | 49 KB | Android 没有 `app.asar` |
| `lib/desktop*.js`（desktop、desktop-entry、desktop-cli、desktop-handoff、desktop-identity、desktop-read-scope） | ~80 KB | 没有 Electron 外壳 |
| `lib/hide-console.js` / `child-process-hide.mjs` / `liangshen*` | ~25 KB | 没有 Windows 控制台 / Liangshen 预设 |
| `lib/update*.js`（update、update-http、update-install、update-policy、…共 13 个） | ~160 KB | dsh-go 的更新走 APK，插件不自更新 |
| `lib/redteam/*` | ~1.1 MB | 独立项目（dsh-redteam-mode），按它自己的装法单独装 |
| `lib/skills.js` / `lib/presets*.js` / `lib/instance.js` / `lib/host*.js` | ~90 KB | 预设切换、技能导入、多宿主布局识别——手机只有一种布局 |
| `bin/*.js` | — | 桌面 CLI（`purge-community status/selfcheck/...`）；本包的 CLI 是 `patches/purge-patch.mjs` |

**一句话**：社区版 518 文件 / ~4.8 MB 里，跟「破甲」直接相关的是**补丁表 + 正文 + 运行时开关**；
本包 40 余文件 / ~1 MB，去掉的全是桌面宿主门面。

---

## 3. dsh-go 侧的关键约束（踩过的坑）

1. **`tools` 要写在顶层 `inject` 数组里**。用 `ctx.inject(['tools'], cb)` 的回调式注册在 dsh-go 上拿不到工具表：
   插件装好了、胶囊在、注入生效，但模型调不到任何 `purge_*` 工具。
2. **原生界面用插件自己的 `ctx` 注册**，不要用 `ctx.inject(['dshGo'], cb)` 的 scoped ctx：
   子 fiber 在桥接服务换代时会被销毁，连带清掉注册（实测注册 339 ms 后被清空）。
   `lib/native.js` 在 1s / 3s / 8s / 20s 各补一次注册覆盖启动窗口，`isLive()` 防止重复闪面板。
3. **面板 `view()` 只返回静态骨架**，数字全部走 `data()` 的 emit（30 秒一次）。
   把扫盘塞进 `view()` 会让 App 每次重绘都扫一遍 88 条目标，手机上会卡死。
4. **慢动作必须用 deferred**（`{ pending, result }`）：同步回调只有 3 秒超时，打补丁要十几秒。
   反之「还原补丁」「开关注入」是本机毫秒级，同步做反而没有「点了取消却弹已完成」的竞态。
5. **`node --check` 可能起不了子进程**（受限沙箱 / proot exec 被拦）：这时标 `UNVERIFIED` 而不是失败，
   否则会把整批补丁误回滚。
6. **`config` 层不要写 `- id: system-prompt / config:`**：dsh-go 的宿主装配不保证支持按 id 合并第三方 config。
   身份段压制改在 waterfall 里做（`harness:identity` / `deployment:persona-*` 直接丢）。

---

## 4. 同步上游的操作

```sh
# ① 补丁表变了（社区版加了/改了补丁）
node scripts/export-community-patches.mjs --community ../dsh-purge-community
node scripts/run-tests.mjs patch-table

# ② 正文变了（社区版重写了正文）
node scripts/reseal-prompt.mjs --community ../dsh-purge-community
node scripts/run-tests.mjs prompt

# ③ 全量
node scripts/run-tests.mjs
```

导出脚本对社区版源码的两处依赖是**文本级**的：

- `lib/patches/index.mjs` 的 `ALL_PATCHES`（import 取数组）
- `lib/core.js` 里 `export function targetFiles(...)` 到 `return filterTargetFiles(files)` 之间的对象字面量

社区版若重命名了这两个位置，导出脚本会直接报错（不会静默产出空表）。
