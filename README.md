# dsh-purge-community-go

简体中文 | [English](README.en.md)

把社区维护版 **dsh-purge-community**（[kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)，MIT）的「破甲」能力，
搬成 **dsh-go**（Android / proot 里的手机 DSH）的原生插件。

它继承了 **dsh-purge-go** 的形态（[NANA7MI0/dsh-purge-go](https://github.com/NANA7MI0/dsh-purge-go)，AGPL-3.0）：
同一套 dshGo 原生桥（胶囊 / 面板 / 状态条）、同一套组装 waterfall、同一套补丁执行器。
**内容**换成社区版：**88 条补丁表 + 社区版注入正文 + boost / 探针 / 注入位置 / 题材分类**。

一句话：**手机上的社区版破甲**——社区版的数据 + dsh-go 的接线。

> 它不改模型权重、不发网络请求、不动你的项目文件。
> 它只做两件事：组装系统提示时注入正文并压掉官方身份段；把执行侧的审批/沙箱默认值改掉。

---

## 1. 两层，各管一件事

| 层 | 在哪 | 改什么 | 什么时候生效 |
|---|---|---|---|
| **注入层** | 本包运行时（`lib/`） | `system-prompt/assemble` waterfall：注入正文顶到最前/最后、压掉 `harness:identity` 与 persona 段、追加能力协议 / 强化段 / 探针 | 插件加载后**立刻**，新会话可见 |
| **补丁层** | 引擎 `node_modules/@deepseek-ai` | 88 条源码补丁：审批策略默认值、沙箱文案、身份段、工具拒绝文案、回退行为… | 打完要**重启引擎** |

缺一个都只是半套：只有注入层，模型说得像但动不了手；只有补丁层，能动手但口气还是官方的。

### 1.1 手机上的沙箱：只改「说法」，不改「能力」

`dsh-sandbox-local` 里的 `(allow file-write*)` 是 **macOS Seatbelt（SBPL）** 语法，配 `sandbox-exec` 生效。
**Android proot 上没有这套后端**（bubblewrap / Landlock 都不可用）。所以那几条沙箱补丁在手机上：

- 规则层：从来没执行过，打不打一样；
- 提示层：真的把「read-only」那句换成了允许写——**模型有多敢写由它决定，文件能不能写不由它决定**。

真正在手机上起作用的是**审批那一组**（#5 #8 #9 #10 #11 #12）与**身份/守卫那一组**（#25 #55 #66 #67 #68 #72 #87 #88）。

---

## 2. 安装

### 2.0 把代码放到手机上

两种拿法，任选一种（都要落在**持久目录**，别放 `/tmp`、别放 `/sdcard` 直接跑）：

```sh
# ① git（推荐，之后 git pull 就能更新）
mkdir -p ~/src && cd ~/src
git clone https://github.com/jick-nice/dsh-purge-community-go.git
mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go

# ② Release 产物（没有 git 时用；带 SHA256SUMS 可以核对有没有传坏）
curl -L -o /tmp/pg.tar.gz \
  https://github.com/jick-nice/dsh-purge-community-go/releases/download/v1.0.0/dsh-purge-community-go-1.0.0.tar.gz
mkdir -p ~/src && tar -xzf /tmp/pg.tar.gz -C ~/src
mv ~/src/dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go
```

前提：引擎 **0.2.x**、`dsh` 与 `pnpm` 都在 `PATH` 里；`/etc/dsh-app/runtime.json` 存在（脚本靠它判断是 dsh-go，
没有这个文件就跳过「建原生界面目录」，装完没有胶囊）。

### 2.1 让 AI 帮你装

> 帮我把 https://github.com/jick-nice/dsh-purge-community-go 装到我这台手机上：
> 先跑 `sh install.sh --dry` 看会改哪些文件，再跑 `sh install.sh`。
> 装完告诉我补丁打了几条、注入层是否开启，**重启由我自己操作**。

### 2.2 手动三条命令

```sh
cd ~/dsh-purge-community-go
sh install.sh --dry     # ① 只看不改：扫 88 条补丁，告诉你哪些能打
sh install.sh           # ② 打补丁 → 建原生界面目录 → 装插件
am force-stop io.github.ccch1mneyyy.dsh_app   # ③ 重启引擎（补丁只有重启后才加载）
```

`install.sh` 的参数：

| 参数 | 作用 |
|---|---|
| 不带参数 | 打补丁 + 建原生界面目录 + 装插件（推荐） |
| `--plugin-only` | 只装插件，不打补丁（注入层生效，引擎限制仍在） |
| `--dry` | 只扫描 + 预演，什么都不改 |
| `--profile web` | 指定 profile，默认 `web` |

**为什么插件放最后**：`dsh plugin add` 会让宿主重新装配插件层，是整条流程里唯一可能打断命令的一步；
补丁和原生目录都是纯文件操作。万一被打断，前面两样已经落地，重跑一次脚本即可。

**必须放持久目录**：`/tmp` 是内存盘（重启清空，软链全断），`/sdcard` 是 FAT32（没有执行位）。

### 2.3 装完怎么确认

```sh
# ① 正文有没有落盘（约 26 KB）
ls -l ~/.dsh/prompt-inject.md

# ② 状态文件
cat ~/.dsh/dsh-purge/state.json        # 应该有 "enabled": true

# ③ 补丁层
cd ~/dsh-purge-community-go && node patches/purge-patch.mjs probe
```

最快的一条是**点输入框上方的「破甲状态」胶囊**：补丁层大数字与注入层五行都在那一屏。

---

## 3. 界面：胶囊 + 面板 + 状态条

装完输入框上方多一个「破甲状态」胶囊，点它直接打开**破甲状态面板**。

面板从上到下：

| 块 | 显示什么 |
|---|---|
| **一句总结** | 绿=完全正常；黄=有补丁待处理；红=注入关了或补丁被 App 更新冲掉 |
| **补丁层** | `已生效/手机适用`，例如 `55/57`；判据与说明见 §5 |
| **注入层五行** | 注入（开/关）、正文（KB）、变体、模型、待办 |
| **一行小字** | `位置 head · 强化段 开 · 探针 purge-xxxx · 分类 6 · 可选 2 条未打` |
| **四个按钮** | **重读** / **一键注入** / **开关注入** / **还原补丁** |
| **明细表** | 按状态分表（可以再打 / 被升级冲掉 / 打不上 / 目标文件缺失 / 部分生效 / 无目标句 / 已生效 / 桌面专属），每行给一句「怎么办」 |

**状态条**（输入框上方红条）只在出问题时自己冒出来，三句话可选：
`破甲未工作 · 点开修复` / `破甲已关 · 点开恢复` / `破甲异常 · 点开处理`。点它也进同一个面板。

**一键注入**是 deferred 动作：App 会一直转圈到打完（最多 60 秒），打完提示「重启后生效」。
手机上打 88 条补丁是十几秒级的活，同步返回会撞 3 秒回调超时。

---

## 4. 工具与命令

### 4.1 八个工具（对话里直接调）

| 工具 | 干什么 |
|---|---|
| `purge_status` | 两层状态：注入层字段 + 88 条补丁的分布与「为什么没打上」 |
| `purge_apply` | 开启注入并确保正文存在（`force=true` 覆盖重写正文） |
| `purge_revert` | 关闭注入，把正文备份到 `dsh-purge/backups/` |
| `purge_prompt` | 正文与变体：`show` / `set` / `reset` / `use` / `default` / `map` |
| `purge_category` | 题材分类扩展层：`list` / `add` / `rm` / `on` / `off` / `reset` / `bake` |
| `purge_tuning` | 社区版开关：`show` / `boost` / `position` / `extra` |
| `purge_probe` | 运行时探针：`new`（生成 nonce）/ `clear` |
| `purge_patch_apply` | 补丁层：`apply` / `restore` / `probe`（走子进程，带 120 秒超时） |

### 4.2 `/purge` 斜杠命令

```
/purge status                       现状（开关、来源、体积、变体、位置、补丁层）
/purge on | off                     开关注入
/purge apply [force]                开启并确保正文存在
/purge revert                       关闭并把正文备份
/purge seed [force]                 重写包内默认正文
/purge prompt show|set <文件>|reset  正文读写（手机上从文件读最省事）
/purge variant list|use <名>|default|map <模型> <名|->
/purge cat list|show|on|off|add|rm|reset|bake   题材分类扩展层
/purge boost on|off                 尾部强化段
/purge position head|tail|both      注入位置
/purge extra <id,id|->              默认关闭补丁的白名单
/purge probe [new|clear]            运行时探针
/purge patches [probe|apply|restore] 补丁层
/purge home                         相关路径
```

记不住就敲 `/purge help`。

---

## 5. 88 条补丁：哪些在手机上真能打

补丁表整套来自社区版（`lib/patches/*.mjs` 六个模块，导出成 `patches/patches.json`）。
判定逻辑和状态词跟 dsh-purge-go 一致，但**数据是社区版的 88 条**：

| 状态 | 含义 |
|---|---|
| `applied` | 目标状态已满足（改过了，或本来就不需要改） |
| `hit` | 查找串还在，可以打但还没打 |
| `partial` | 改了一部分，还剩一部分（**不是**「已经生效」） |
| `drifted` | 打过但被冲掉了（App 更新重装引擎包） |
| `miss` | 一条都对不上（版本不同 / 只适用桌面端） |
| `no_pkg` | 目标包没装（桌面专属的那些就是这样） |
| `no_file` | 包在、文件路径不在 |
| `no_needle` | 数据里这条的 pattern 不可用 |

**分母是「手机适用条数」**，不是 88：桌面专属（`surfaces: ["desktop"]`，7 条）与目标包不存在的都不进分母。
补丁大面积为未打状态时面板显示「未打」，不显示 `2/57` 那种容易误读的数。

**两条 `opt-in`**（#18 重复调用提醒、#19 工具结果修剪）默认不打，要打用：

```
/purge extra 18,19      # 白名单，下次打补丁时一起打
```

### 5.1 文件键 → 包名 + 相对路径

社区版的补丁用「文件键」引用目标（`agent-loop`、`base`、`sandbox-policy`、`user-approval-code`…），
由社区版的 `targetFiles(aiBase)` 映射成绝对路径。dsh-go 的引擎布局不同，所以导出时把那张表
抽成了 `patches/patches.json` 里的 `fileTargets`：

```json
"sandbox-policy": [{ "pkg": "dsh-sandbox-policy", "rel": ["lib", "index.js"] }]
```

执行器（`patches/lib/core.mjs`）只认这一张表；表里没有的键退化成 `dsh-<键>` + `lib/index.js`，
包不存在时自然落成 `no_pkg`，不会误改别的文件。

### 5.2 打完记得：补丁不是永久的

**App 更新会重装引擎包（`/opt/dsh/node_modules/@deepseek-ai/`），补丁被整个冲掉。**
这不是安装失败，是已知限制。判断方法：输入框上方自己冒出红条、顶部写着「补丁被覆盖了」。
修法：`/purge patches apply`，或者点面板上的「一键注入」，然后重启引擎。

---

## 6. 社区版带来的四样运行时能力

### 6.1 boost：尾部强化段

`/purge boost on|off`。段号 `-50000`（在头部注入之后、正文主体之前），关掉时正文为空（段还在，代价为零）。
默认**开**——破甲是这个插件唯一的目的，默认不留门。

### 6.2 position：注入位置

`/purge position head|tail|both`。

- `head`（默认）：正文顶到系统提示最前，稳定前缀，缓存友好；
- `tail`：放在 `10150`（WEB_SURFACE 之后、persona-suffix 之前），紧贴输出，多轮衰减最小；
- `both`：两头各一份。

`tail` 时头部仍保留一个空的 `dsh-purge` 段占位——别的补丁会按名字找它。

### 6.3 运行时探针：证明注入真的到了模型

```
/purge probe
```

生成一次性 nonce（`purge-xxxxxxxx`，30 分钟过期），并在系统提示尾部挂一段「原样回显」的短指令。
**任意发一句对话，模型把 nonce 原样回显 = 链路通。**
回显了但模型仍推脱 → 问题在模型层/人设；没回显 → 注入没到达（看 `purge_status` 的注入层与 `boost` 开关）。

### 6.4 能力选用协议 + 题材分类扩展层

- 能力选用协议（`dshpg-capabilities` 段）：教模型先读 skill / MCP 目录再按任务选用。想换正文就写
  `~/.dsh/dsh-purge/capabilities.md`。
- 题材分类扩展层：把 Scoped Rules 26+ 与意图映射扩展行在组装时拼进正文（数据在 `assets/categories.json`，
  覆盖层写 `<DSH_HOME>/dsh-purge/categories.json`）。`/purge cat bake` 可以把当前分类直接写进正文。

---

## 7. 和社区桌面版的差别

| 项 | 社区版 dsh-purge-community | 本包 |
|---|---|---|
| 目标宿主 | DSH Desktop（Electron + asar） | dsh-go（Android proot，单个 node 进程） |
| 界面 | Web slot 面板（`packages/purge-panel`，需浏览器） | dsh-go 原生桥：胶囊 / 面板 / 状态条 |
| 补丁执行 | `lib/core.js` 的 `targetFiles(aiBase)` 路径表 | 同表导出成 `fileTargets`，执行器重写 |
| asar 解包 / 换包 / 计划任务 | 有 | **丢弃**（Android 上没有这些对象） |
| 预设包 / Liangshen / Electron 外壳 | 支持 | 目标包本来就没有 → 显示 `no_pkg` / 桌面专属 |
| 红队演练台（`lib/redteam`） | 内置 | **不搬**（独立项目，见下） |
| 更新器（`update*.js`） | 有 | **不搬**（dsh-go 的 App 更新走 APK） |
| 注入正文 | 加密在 `lib/asset-table.js` | 同一份明文，本包重新封装成 `lib/asset-table.json` |

**没搬的模块与理由**（逐条）：见 [docs/port-notes.md](docs/port-notes.md)。

**红队**：社区版内置的演练台（资产库、攻击链、技能）是独立项目
[Jueze-2019/dsh-redteam-mode](https://github.com/Jueze-2019/dsh-redteam-mode)，本包不带。
想要的话按它自己的装法单独装，两者互不依赖。

---

## 8. 目录

```
lib/
  index.js            插件入口：段注册 + waterfall + 工具/命令/原生界面接线
  home.js             路径与原子落盘（$DSH_HOME/dsh-purge/*）
  state.js            state.json（开关、变体、按模型指定、上次注入）
  prompt.js           正文解析优先级、变体、seed、插值转义
  assemble.js         system-prompt/assemble：位置（head/tail/both）、压冲突段、段重排
  capability.js       能力选用协议段
  community.js        tuning.json（boost/position/extra）+ 运行时探针 + 强化段正文
  ops.js              动作层（面板/命令/工具共用）
  view.js             snapshot / 补丁层缓存 / 工具卡
  dshgo.js            dsh-go 面板：静态骨架 + data() + 四个按钮
  native.js           原生界面注册与重注册
  tools.js            八个工具
  commands.js         /purge
  categories.js       题材分类扩展层
  recover.js          拒答续跑
  card.js             工具卡（零依赖）
  table-read.js       解开 lib/asset-table.json
  table-key.js        正文加密/密钥派生
patches/
  patches.json        88 条补丁 + fileTargets（由社区版导出）
  purge-patch.mjs     CLI：probe / apply / restore
  lib/core.mjs        执行器：探测、事务式应用、备份、还原、校验
scripts/
  export-community-patches.mjs  从社区版导出补丁表
  reseal-prompt.mjs             从社区版正文重新封装
  build-dist.mjs                构建 dist/（tar.gz + zip + SHA256SUMS + manifest + Release 正文）
  run-tests.mjs                 进程内测试（node --test 的替代）
  engine-smoke.mjs              真引擎冒烟（有 dsh 引擎时）
  kit-check.mjs                 dsh-go plugin-kit 校验（有 kit 时）
test/                 67 个用例：清单 / 补丁表 / 执行器 / 正文 / 组装 / 面板 / 工具 / 开关 / 续跑
dist/                 构建产物（发布用；解包校验过的 tar.gz / zip、SHA256SUMS、manifest.json）
docs/                 port-notes.md（中文）/ port-notes.en.md（英文）
README.md / README.en.md   中文主文档 / 英文对照
```

---

## 9. 已知限制

1. **只对新会话完全生效**。系统提示写进对话历史（`systemPromptUpdate: "in-history"`），旧会话那条旧的 system 顶不动。
2. **补丁改的是 `node_modules`**：升级引擎或装新版 App 会重装、补丁全丢，之后重跑 apply。
3. **`node --check` 只验语法不验语义**；本机连子进程都不许起时（受限沙箱）会标 `UNVERIFIED`，不阻断。
4. **`partial` 不是「已生效」**。健康与否只看 `applied` 条数（低于 10 条判定被覆盖）。
5. **只适配 DeepSeek**。正文按 DeepSeek / ChatML 格式写的，换别的模型不报错但效果打折。
6. **社区版的几个桌面能力无法在手机上生效**：预设切换、桌面 Web 面板、asar 热换、更新器。

---

## 10. 卸载与还原

```sh
# ① 还原补丁层（最容易漏）
cd ~/dsh-purge-community-go
node patches/purge-patch.mjs restore --backup "$(ls -d ~/.dsh/dsh-purge/patch-backup/* | tail -1)"
# 或者点面板上的「还原补丁」

# ② 摘插件
dsh plugin --profile web remove dsh-purge-community-go

# ③ 删原生界面目录（不删的话 App 还认为插件有界面，里面全是断链）
rm -rf ~/.dsh/dsh-go/plugins/dsh-purge-community-go

# ④ 删仓库
rm -rf ~/dsh-purge-community-go
```

**备份没了也能救**：`/opt/dsh/package-lock.json` 里记着引擎包版本，按它重装原版包即可。

正文（`~/.dsh/prompt-inject.md`）与开关（`~/.dsh/dsh-purge/state.json`）不会被卸载删掉——
想连正文一起清掉再手动删。

---

## 11. 维护：从上游同步

### 11.1 补丁表

```sh
node scripts/export-community-patches.mjs --community ../dsh-purge-community
```

做三件事：读社区版 `lib/patches/index.mjs` 的 `ALL_PATCHES` → 把 RegExp 形态的 pattern 写成 `{source, flags}` →
从 `lib/core.js` 的 `targetFiles()` 抽出「文件键 → 包名 + 相对路径」，缺的键用脚本里的 `FALLBACK_TARGETS` 补齐。

社区版加补丁后重跑一次即可，本包执行器不用改。

### 11.2 注入正文

```sh
node scripts/reseal-prompt.mjs --community ../dsh-purge-community
```

从社区版 `lib/asset-table.js` 解出正文，用本包自己的盐重新封装成 `lib/asset-table.json`（正文一个字不改）。

### 11.3 测试

```sh
node scripts/run-tests.mjs          # 进程内跑，67 个用例
node scripts/run-tests.mjs prompt   # 只跑文件名含 prompt 的
```

### 11.4 构建产物

```sh
node scripts/build-dist.mjs      # 生成 dist/：tar.gz + zip + SHA256SUMS + manifest.json + RELEASE_NOTES.md
```

脚本做四件事，任何一步失败都直接非零退出（不会把空壳当产物发出去）：

1. 按**白名单**把 52 个文件复制到临时 stage 目录（`lib/ patches/ assets/ scripts/ docs/ test/` 与各 README、许可证），再从 stage 打 `dist/dsh-purge-community-go-<版本>.tar.gz`——`.git` / `dist` / `node_modules` / 日志天然进不去；
2. 顺手出 `zip`（`zip` 命令 → bsdtar `-a` → Windows 的 Compress-Archive 依次尝试，写完查 PK 魔数；都不行就只出 tar.gz）；
3. **解包到临时目录回校验**：13 个关键文件齐全 + 归档里的版本号与 `package.json` 一致；
4. 写 `manifest.json`（逐文件 sha256）、`SHA256SUMS`、`RELEASE_NOTES.md`（中文安装步骤 + 校验值）。

打 tag 之后 GitHub Actions（`.github/workflows/release.yml`）会跑同一套流程并创建 Release：

```sh
git tag v1.0.0 && git push origin v1.0.0
```

CI 里同时跑 `npm test`（67 个用例），测试不过不会发版。

---

## 12. 许可

- 本包：**AGPL-3.0**（注入层与 dsh-go 接线来自 dsh-purge-go）
- 补丁表与正文：**MIT**（来自 dsh-purge-community，原文见 `LICENSE-community`）
- 完整来源与分工见 `NOTICE`

正文与补丁表是「同一份内容的另一种封装」，许可证按上游中最严格的那份适用。
