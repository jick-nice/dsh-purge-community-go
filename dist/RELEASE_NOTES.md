# dsh-purge-community-go v1.0.0

把 **dsh-purge-community**（社区维护版破甲）搬成 **dsh-go** 手机端原生插件：
内容用社区版（88 条补丁表 + 注入正文 + boost / 探针 / 注入位置 / 题材分类），
形态用 dsh-go（原生胶囊 / 面板 / 状态条、组装 waterfall、事务式补丁执行器）。

## 构建产物

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `dsh-purge-community-go-1.0.0.tar.gz` | 167.5 KB | `9001ec90d057012e87d5b75f15c4f0c4835b3c969d395a37205206a92e8dd52e` |
| `dsh-purge-community-go-1.0.0.zip` | 199.4 KB | `fa0727fccf46ea424218b195b0e350409ea2866e8eb272de506169e389647057` |

构建时间：2026-11-20T15:03:50.624Z · Node v22.23.4 · win32-x64

## 手机安装（Android + proot）

```sh
mkdir -p ~/src && cd ~/src
curl -L -o pg.tar.gz https://github.com/jick-nice/dsh-purge-community-go/releases/download/v1.0.0/dsh-purge-community-go-1.0.0.tar.gz
tar -xzf pg.tar.gz && mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go

sh install.sh --dry     # 只扫不打
sh install.sh           # 补丁 -> 原生界面目录 -> 插件
am force-stop io.github.ccch1mneyyy.dsh_app   # 重启引擎
```

装完点输入框上方的「破甲状态」胶囊；要证明注入到达模型，敲 `/purge probe` 并让模型回显 nonce。

## 校验

```sh
sha256sum dsh-purge-community-go-1.0.0.tar.gz    # 与上表对应
```

## 内容

- 补丁表来自 dsh-purge-community 1.7.20（MIT），导出为 `patches/patches.json`（88 条 + fileTargets）
- 注入正文与社区版同一份明文，用本包自己的盐重新封装（AES-256-GCM + deflate）
- 桌面专属能力（Electron / asar / 计划任务 / 更新器 / 红队演练台）未移植，理由见 docs/port-notes.md

许可：本包 AGPL-3.0；补丁表与正文 MIT（见 NOTICE 与 LICENSE-community）。
