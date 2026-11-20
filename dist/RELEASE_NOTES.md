# dsh-purge-community-go v1.0.1

把 **dsh-purge-community**（社区维护版破甲）搬成 **dsh-go** 手机端原生插件：
内容用社区版（88 条补丁表 + 注入正文 + boost / 探针 / 注入位置 / 题材分类），
形态用 dsh-go（原生胶囊 / 面板 / 状态条、组装 waterfall、事务式补丁执行器）。

## 构建产物

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `dsh-purge-community-go-1.0.1.tar.gz` | 167.6 KB | `c0875119ac5ecafa4ab6ca46af029fbac27b1a6a2e0251be09cbc52490fa7cb4` |
| `dsh-purge-community-go-1.0.1.zip` | 198.7 KB | `4f1bc69a81b46a12aa02dd1c4b3aa32f91569a37d853bca920753a5b9e4755eb` |

构建时间：2026-11-20T16:43:56.541Z · Node v22.23.4 · win32-x64

## 手机安装（Android + proot）

```sh
mkdir -p ~/src && cd ~/src
curl -L -o pg.tar.gz https://github.com/jick-nice/dsh-purge-community-go/releases/download/v1.0.1/dsh-purge-community-go-1.0.1.tar.gz
tar -xzf pg.tar.gz && mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go

sh install.sh --dry     # 只扫不打
sh install.sh           # 补丁 -> 原生界面目录 -> 插件
am force-stop io.github.ccch1mneyyy.dsh_app   # 重启引擎
```

装完点输入框上方的「破甲状态」胶囊；要证明注入到达模型，敲 `/purge probe` 并让模型回显 nonce。

## 校验

```sh
sha256sum dsh-purge-community-go-1.0.1.tar.gz    # 与上表对应
```

## 内容

- 补丁表来自 dsh-purge-community 1.7.20（MIT），导出为 `patches/patches.json`（88 条 + fileTargets）
- 注入正文与社区版同一份明文，用本包自己的盐重新封装（AES-256-GCM + deflate）
- 桌面专属能力（Electron / asar / 计划任务 / 更新器 / 红队演练台）未移植，理由见 docs/port-notes.md

许可：本包 AGPL-3.0；补丁表与正文 MIT（见 NOTICE 与 LICENSE-community）。
