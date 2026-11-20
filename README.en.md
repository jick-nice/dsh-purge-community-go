<div align="center">

# Purge for dsh-go

**The community edition of dsh-purge, wired into dsh-go on Android.**

88 engine patches · injected prompt body · native panel · 8 tools · zero runtime dependencies

[![release](https://img.shields.io/github/v/release/jick-nice/dsh-purge-community-go?label=release&color=2ea44f)](https://github.com/jick-nice/dsh-purge-community-go/releases)
[![ci](https://github.com/jick-nice/dsh-purge-community-go/actions/workflows/ci.yml/badge.svg)](https://github.com/jick-nice/dsh-purge-community-go/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/jick-nice/dsh-purge-community-go?color=blue)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Android%20%2F%20proot-informational)](https://github.com/jick-nice/dsh-purge-community-go/releases)

Version **1.0.1** · targets **dsh-go 0.2.x** (Android / proot, no root)

English · [简体中文（主文档）](README.md)

[Install](#install) · [Panel](#what-you-get) · [Commands](#everyday-commands) · [Patches](#reading-the-88-patches) · [Limits](#known-limits)

</div>

---

## What it is

A native plugin for dsh-go. After installation there is a **Purge status** capsule above the composer; tapping it opens live state for both layers.

It does two things:

- **Injection** — puts the community prompt body into the assembled system prompt, at head or tail, and drops the official identity sections.
- **Patches** — writes the community's 88 source patches into the engine packages, changing approval defaults, sandbox wording and identity strings that otherwise block tool calls.

No model weights touched, no network requests, no project files modified, no host restarts.

## Why a port

The community edition targets desktop DSH. Its patches are addressed through an absolute-path table, and its UI is a browser web slot. On the phone every one of those paths is missing and the web client never loads.

This package moves the content onto dsh-go's official extension points: `system-prompt/assemble`, `tools`, `commands`, and the `dshGo` bridge.

| Upstream | What is reused |
|---|---|
| [dsh-purge-community](https://github.com/kingcharleslzy-ai/dsh-purge) 1.7.20 (MIT) | 88-patch table, prompt body, boost / probe / inject position / category overlay |
| [dsh-purge-go](https://github.com/NANA7MI0/dsh-purge-go) 0.5.6 (AGPL-3.0) | native bridge, assembly waterfall, patch executor, refusal recovery |

Desktop-only machinery is not included: Electron, asar, scheduled tasks, the updater, the web panel, the red-team console. Module-by-module reasoning lives in [docs/port-notes.en.md](docs/port-notes.en.md).

## What you get

The capsule opens this panel (text rendering, not a screenshot):

```
+--------------------------------------+
| Purge is healthy.                     |  <- amber/red when something is off
|                                      |
| Patches                    55 / 57   |  <- applied / phone-applicable
| 57 applicable - 55 applied -          |
| 1 pending - 31 desktop-only          |
|                                      |
| Inject  on         Prompt  26.2 KB    |
| Variant default    Model   deepseek   |
| Todo    nothing to do                 |
| Position head - Boost on - Probe off  |
|                                      |
| [Reload][Inject all][Toggle][Revert]  |
+--------------------------------------+
```

The panel is mounted on the session tab, the chat side panel and the features page. When something is wrong, an alert strip appears above the composer on its own and opens the same panel.

**Reload** rescans the engine. **Inject all** enables injection and applies patches (deferred, up to 60 s). **Toggle** switches injection only. **Revert** restores files from the latest backup.

## Install

Requirements: dsh-go installed, engine **0.2.x**, `dsh` and `pnpm` on `PATH`, and a persistent directory (not `/tmp`, not `/sdcard`).

```sh
mkdir -p ~/src && cd ~/src
git clone https://github.com/jick-nice/dsh-purge-community-go.git
mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go

sh install.sh --dry      # scan only: which of the 88 patches can apply here
sh install.sh            # patches -> native UI directory -> plugin
am force-stop io.github.ccch1mneyyy.dsh_app    # restart the engine
```

From the release artifact instead of git:

```sh
mkdir -p ~/src && cd ~/src
curl -L -o pg.tar.gz https://github.com/jick-nice/dsh-purge-community-go/releases/download/v1.0.1/dsh-purge-community-go-1.0.1.tar.gz
sha256sum pg.tar.gz     # compare with SHA256SUMS on the release page
tar -xzf pg.tar.gz && mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go
sh install.sh
```

Flags: no argument installs everything; `--plugin-only` skips engine patching; `--dry` changes nothing; `--profile web` selects a profile.

The plugin goes last because `dsh plugin add` makes the host rebuild the plugin layer and is the only step that can interrupt the running command. The two earlier steps are pure file operations.

Verify:

```sh
ls -l ~/.dsh/prompt-inject.md          # about 26 KB
cat ~/.dsh/dsh-purge/state.json        # "enabled": true
node patches/purge-patch.mjs probe     # applicable / tally
```

To prove the injection reaches the model, run `/purge probe` and ask the model to echo the generated `purge-xxxxxxxx` verbatim.

## Everyday commands

```
/purge status                     both layers
/purge on | off                   toggle injection
/purge patches apply | restore    re-apply or revert patches
/purge probe [new|clear]          runtime probe
/purge boost on|off               tail boost section
/purge position head|tail|both    injection position
/purge extra 18,19                include the two opt-in patches
/purge prompt set /sdcard/x.md    replace the body from a file
/purge cat list                   category overlay
/purge home                       paths
```

The same eight actions exist as tools: `purge_status`, `purge_apply`, `purge_revert`, `purge_prompt`, `purge_category`, `purge_tuning`, `purge_probe`, `purge_patch_apply`.

## Reading the 88 patches

| Status | Meaning | Action |
|---|---|---|
| `applied` | target state reached | none |
| `hit` | pattern present, not applied yet | tap Inject all |
| `drifted` | applied before, wiped by an app update | tap Inject all |
| `partial` | partly applied | none, the matching variant is in place |
| `miss` | this engine build has no such code | none |
| `no_file` | this engine build has no such file | none |
| `no_needle` | the entry has no usable pattern | none |
| `no_pkg` | target package absent (desktop-only) | none |

The denominator is the **locally applicable count** = landed (`applied` + `partial`) + pending (`hit` + `drifted`).

One real device on 0.2.2 reads `67/68`: 65 applied, 2 partial, 1 wiped by an app update, plus 11 that this
engine build simply does not contain and 9 desktop-only. Those 20 stay out of the denominator and are never
counted as work to do. One tap on Inject all turns it into `68/68` and the verdict reads "all normal".

To see exactly what the inapplicable entries are looking for, run `/purge env`: it prints the packages found in
the engine, each patch's target path, and how many patterns are still unmatched.

Two patches are off by default: `#18` repeated-tool reminder and `#19` tool-result pruner. Enable them with `/purge extra 18,19`.

**Patches are not permanent.** Updating the app reinstalls the engine packages and wipes them; the alert strip reappears. Tap Inject all and restart.

## Differences from the desktop community edition

| Item | Community | This package |
|---|---|---|
| Host | DSH Desktop (Electron + asar) | dsh-go (Android proot, single node process) |
| UI | web slot panel in a browser | native capsule / panel / alert strip |
| Patch addressing | `targetFiles(aiBase)` absolute paths | same table exported as `fileTargets` (package + relative path) |
| Presets, Liangshen, Electron shell | supported | targets absent, reported as `no_pkg` |
| Updater, red-team console | bundled | not included |

## Known limits

1. Fully effective in new sessions only; the system prompt is written into conversation history.
2. Patches live in `node_modules`; engine or app updates reinstall them and wipe the patches.
3. `node --check` validates syntax only; where child processes are blocked the result is `UNVERIFIED`, not a failure.
4. `partial` does not mean applied. Health is the `applied` count; below 10 means the engine was reinstalled.
5. Tuned for DeepSeek. The body uses a ChatML envelope; other models work but score lower.

## Uninstall

```sh
cd ~/dsh-purge-community-go
node patches/purge-patch.mjs restore --backup "$(ls -d ~/.dsh/dsh-purge/patch-backup/* | tail -1)"
dsh plugin --profile web remove dsh-purge-community-go
rm -rf ~/.dsh/dsh-go/plugins/dsh-purge-community-go ~/dsh-purge-community-go
```

The prompt body (`~/.dsh/prompt-inject.md`) and state file are left in place. If backups are gone, `/opt/dsh/package-lock.json` still records the engine package versions.

## Development

```sh
node scripts/run-tests.mjs                                                      # 67 cases
node scripts/export-community-patches.mjs --community ../dsh-purge-community   # sync patch table
node scripts/reseal-prompt.mjs --community ../dsh-purge-community              # sync prompt body
node scripts/build-dist.mjs                                                     # build dist/
```

52 files, ~170 KB artifact, no runtime dependencies. CI runs Node 20 and 22; a tag builds and publishes the release.

## License

AGPL-3.0 for this package. The patch table and prompt body are MIT, from the community edition; see `LICENSE-community`. Provenance is documented in [NOTICE](NOTICE).
