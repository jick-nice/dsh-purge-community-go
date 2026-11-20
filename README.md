<div align="center">

# 破甲 · dsh-go

**把社区版 dsh-purge-community 的破甲能力，装进手机上的 dsh-go。**

88 条引擎补丁 · 注入正文 · 原生胶囊与面板 · 8 个工具 · 零运行时依赖

[![release](https://img.shields.io/github/v/release/jick-nice/dsh-purge-community-go?label=release&color=2ea44f)](https://github.com/jick-nice/dsh-purge-community-go/releases)
[![ci](https://github.com/jick-nice/dsh-purge-community-go/actions/workflows/ci.yml/badge.svg)](https://github.com/jick-nice/dsh-purge-community-go/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/jick-nice/dsh-purge-community-go?color=blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Android%20%2F%20proot-informational)](https://github.com/jick-nice/dsh-purge-community-go/releases)

当前版本 **1.0.0** · 适配 **dsh-go 0.2.x**（Android / proot，不需要 root）

简体中文（主文档） · [English](README.en.md)

[安装](#安装) · [面板](#装完你会看到什么) · [命令](#常用操作) · [补丁](#88-条补丁怎么读) · [限制](#已知限制)

</div>

---

## 它是什么

一个跑在手机 dsh-go 里的原生插件。装好之后，输入框上方多一个「破甲状态」胶囊，点开是补丁层与注入层的实时状态。

它只做两件事：

- **注入**：组装系统提示时放入社区版正文，送到最前或最后，并压掉官方身份段。
- **补丁**：把社区版整理好的 88 条源码补丁打进引擎包，改掉审批默认值、沙箱文案、身份段这类会拦住工具调用的东西。

不改模型权重，不发网络请求，不碰项目文件，不自动重启宿主。

## 为什么需要移植

社区版只认桌面 DSH：补丁目标是一张绝对路径表，界面走浏览器 Web slot。手机端两个都对不上——路径不存在，Web client 也不加载。

这个包把内容搬出来，接在 dsh-go 的官方扩展点上（`system-prompt/assemble`、`tools`、`commands`、`dshGo` 桥）。

| 上游 | 拿的是什么 |
|---|---|
| [dsh-purge-community](https://github.com/kingcharleslzy-ai/dsh-purge) 1.7.20（MIT） | 88 条补丁表、注入正文、boost / 探针 / 注入位置 / 题材分类 |
| [dsh-purge-go](https://github.com/NANA7MI0/dsh-purge-go) 0.5.6（AGPL-3.0） | dsh-go 原生桥、组装 waterfall、补丁执行器、拒答续跑 |

桌面专属的部件一件没带：Electron、asar、计划任务、更新器、Web 面板、红队演练台。逐条理由见 [docs/port-notes.md](docs/port-notes.md)。

## 装完你会看到什么

输入框上方出现一个胶囊，点开是这一屏（文字还原，非截图）：

```
┌──────────────────────────────────────┐
│ 破甲能力完全正常。                     │  ← 绿底；有问题时变黄/红
│                                      │
│ 补丁层                     55 / 57   │  ← 分子已生效，分母是手机适用条数
│ 手机适用 57 条 · 55 条已生效 ·         │
│ 1 条待处理 · 另 31 条桌面专属         │
│                                      │
│ 注入   开          正文   26.2 KB     │
│ 变体   默认        模型   deepseek    │
│ 待办   没有要处理的                    │
│ 位置 head · 强化段 开 · 探针 无        │
│                                      │
│ [ 重读 ][ 一键注入 ][ 开关注入 ][ 还原 ]│
└──────────────────────────────────────┘
```

点胶囊进面板；面板同时挂在对话页签、聊天侧栏、功能页。出问题时输入框上方还会自己冒一条红条，点它也是进这里。

四个按钮：**重读** 重扫引擎；**一键注入** 打开注入并把补丁打上（转圈，最多 60 秒）；**开关注入** 只切注入层；**还原补丁** 从最近备份恢复文件。

## 安装

前提：dsh-go 已装好，引擎 **0.2.x**，`dsh` 与 `pnpm` 在 `PATH` 里，目录放在持久区（不要 `/tmp`，不要 `/sdcard`）。

### 让 AI 装

> 帮我把 https://github.com/jick-nice/dsh-purge-community-go 装到我这台手机上。先跑 `sh install.sh --dry` 看会改哪些文件，再跑 `sh install.sh`。装完告诉我补丁打了几条、注入层是否开启，重启我自己来。

### 自己装

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/jick-nice/dsh-purge-community-go.git
mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go

sh install.sh --dry      # 只扫描：88 条里哪些能打
sh install.sh            # 打补丁 → 建原生界面目录 → 装插件
am force-stop io.github.ccch1mneyyy.dsh_app    # 重启引擎，补丁这时才加载
```

没有 git 就用 Release 产物：

```sh
mkdir -p ~/src && cd ~/src
curl -L -o pg.tar.gz https://github.com/jick-nice/dsh-purge-community-go/releases/download/v1.0.0/dsh-purge-community-go-1.0.0.tar.gz
sha256sum pg.tar.gz     # 与 Release 页的 SHA256SUMS 对照
tar -xzf pg.tar.gz && mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go
sh install.sh
```

`install.sh` 参数：不带参数全装；`--plugin-only` 只装插件不动引擎；`--dry` 只看不改；`--profile web` 指定 profile。

插件放在最后一步，是因为 `dsh plugin add` 会让宿主重新装配插件层，是唯一可能打断命令的动作。前面两步都是纯文件操作，被打断重跑一次即可。

### 装完核对

```sh
ls -l ~/.dsh/prompt-inject.md          # ~26 KB
cat ~/.dsh/dsh-purge/state.json        # "enabled": true
node patches/purge-patch.mjs probe     # applicable / tally
```

想确认注入真的到了模型：对话里敲 `/purge probe`，生成的 `purge-xxxxxxxx` 让模型原样回显。回显了就是链路通。

## 常用操作

```
/purge status                     两层状态
/purge on | off                   开关注入
/purge patches apply | restore    重打 / 还原补丁
/purge probe [new|clear]          运行时探针
/purge boost on|off               尾部强化段
/purge position head|tail|both    注入位置
/purge extra 18,19                打默认关闭的两条补丁
/purge prompt set /sdcard/x.md    用文件替换注入正文
/purge cat list                   题材分类扩展层
/purge home                       相关路径
```

八个工具同名对应：`purge_status`、`purge_apply`、`purge_revert`、`purge_prompt`、`purge_category`、`purge_tuning`、`purge_probe`、`purge_patch_apply`。AI 可以直接调，不需要你记命令。

## 88 条补丁怎么读

| 状态 | 含义 | 要不要管 |
|---|---|---|
| `applied` | 已达到目标状态 | 不用 |
| `hit` | 查找串在，还没打 | 点「一键注入」 |
| `drifted` | 打过，被 App 更新冲掉 | 点「一键注入」 |
| `partial` | 改了一部分 | 不用，命中那套已生效 |
| `miss` | 一条都对不上 | 看名字：预设/桌面类不用管 |
| `no_pkg` | 目标包没装 | 不用 |
| `no_file` | 包在、文件不在 | 不用 |
| `no_needle` | 这条数据本身缺查找串 | 不用 |

分母是**手机适用条数**，不是 88。桌面专属（7 条）和目标包不存在的都不计入。没打补丁时面板显示「未打」，不显示容易误读的小数字。

两条补丁默认关闭：`#18` 重复调用提醒、`#19` 工具结果修剪。要打就 `/purge extra 18,19`。

**补丁不是永久的。** 更新 App 会重装引擎包，补丁全部丢失，红条会自己冒出来。点「一键注入」重打，然后重启。

## 和社区桌面版的差别

| 项 | 社区版 | 本包 |
|---|---|---|
| 宿主 | DSH Desktop（Electron + asar） | dsh-go（Android proot，单 node 进程） |
| 界面 | Web slot 面板，浏览器里开 | 原生胶囊 / 面板 / 状态条 |
| 补丁定位 | `targetFiles(aiBase)` 绝对路径表 | 同一张表导出成 `fileTargets`（包名 + 相对路径） |
| 预设、Liangshen、Electron 外壳 | 支持 | 目标包不存在，显示 `no_pkg` |
| 更新器、红队演练台 | 内置 | 不带 |

## 已知限制

1. 只对新会话完全生效。系统提示写进对话历史，旧会话顶不动。
2. 补丁改的是 `node_modules`。升级引擎或 App 会重装，补丁全丢。
3. `node --check` 只验语法。环境不许起子进程时标 `UNVERIFIED`，不阻断打补丁。
4. `partial` 不等于生效。健康看 `applied` 条数，低于 10 条判定被覆盖。
5. 只适配 DeepSeek。正文按 ChatML 格式写的，换模型不报错但效果打折。

## 卸载

```sh
cd ~/dsh-purge-community-go
node patches/purge-patch.mjs restore --backup "$(ls -d ~/.dsh/dsh-purge/patch-backup/* | tail -1)"
dsh plugin --profile web remove dsh-purge-community-go
rm -rf ~/.dsh/dsh-go/plugins/dsh-purge-community-go ~/dsh-purge-community-go
```

正文 `~/.dsh/prompt-inject.md` 和开关 `state.json` 不会跟着删，要清手动删。备份丢了也能救：`/opt/dsh/package-lock.json` 里记着引擎包版本。

## 开发

```sh
node scripts/run-tests.mjs                                  # 67 个用例
node scripts/export-community-patches.mjs --community ../dsh-purge-community   # 同步补丁表
node scripts/reseal-prompt.mjs --community ../dsh-purge-community              # 同步正文
node scripts/build-dist.mjs                                 # 产出 dist/ 四个文件
```

仓库 52 个文件，产物约 170 KB，零运行时依赖。CI 跑 Node 20 与 22；打 tag 自动构建并发布 Release。

## 许可

本包 AGPL-3.0；补丁表与正文来自社区版，MIT（原文见 `LICENSE-community`）。来源分工写在 [NOTICE](NOTICE)。
