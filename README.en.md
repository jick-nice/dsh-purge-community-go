# dsh-purge-community-go

**English** | [简体中文](README.md)

A **dsh-go** (mobile DSH on Android/proot) port of the community-maintained **dsh-purge-community**
([kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge), MIT).

It keeps the **content** of the community edition — the 88-entry engine patch table, the community injection
body, and the runtime switches (boost / probe / inject position / category overlay) — and takes its **shape**
from [dsh-purge-go](https://github.com/NANA7MI0/dsh-purge-go) (AGPL-3.0): the native dsh-go bridge
(composer capsule, native panel, alert strip), the `system-prompt/assemble` waterfall, and a transactional
patch executor.

In one line: **the community edition, wired for the phone.**

> It does not touch model weights, does not make network requests, and does not modify your project files.
> It does exactly two things: inject the prompt body into the assembled system prompt (and drop the official
> identity sections), and rewrite the engine's approval/sandbox defaults on disk.

---

## 1. Two layers

| Layer | Where | What it changes | When it takes effect |
|---|---|---|---|
| **Injection** | this package at runtime (`lib/`) | `system-prompt/assemble`: hoists the body to head or tail, drops `harness:identity` and persona sections, appends capability protocol / boost / probe sections | immediately after load, visible in **new** sessions |
| **Patch** | engine `node_modules/@deepseek-ai` | 88 source patches: approval defaults, sandbox wording, identity stripping, tool-denial text, rewind behaviour | after `apply` **and an engine restart** |

Neither layer is sufficient alone: injection alone makes the model *sound* cooperative but unable to act;
patches alone make it able to act but still sound official.

### 1.1 Sandbox patches on Android

The `(allow file-write*)` strings inside `dsh-sandbox-local` are **macOS Seatbelt (SBPL)** rules executed by
`sandbox-exec`. Android/proot has no such backend (no bubblewrap, no Landlock), so those patches:

- **do not** change what the filesystem permits — that layer never runs on the phone;
- **do** change the sentence the model reads (`read-only` → allowed). The patch changes *how willing the model
  is to write*, not *whether writing is possible*.

What actually matters on the phone is the **approval** group (#5 #8 #9 #10 #11 #12) and the
**identity / guard** group (#25 #55 #66 #67 #68 #72 #87 #88).

---

## 2. Install (on the phone)

Prerequisites: dsh-go installed, engine **0.2.x**, `dsh` and `pnpm` on `PATH`, and a persistent home directory
(not `/tmp`, not `/sdcard`).

```sh
# 1) get the code into a persistent directory
mkdir -p ~/src && cd ~/src
git clone https://github.com/jick-nice/dsh-purge-community-go.git
mv dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go

# 2) dry run: scan the 88 patches, change nothing
sh install.sh --dry

# 3) apply patches -> create the native UI directory -> install the plugin
sh install.sh

# 4) restart the engine (patches only load on boot)
am force-stop io.github.ccch1mneyyy.dsh_app
```

Without git, use the release artifact:

```sh
curl -L -o /tmp/pg.tar.gz \
  https://github.com/jick-nice/dsh-purge-community-go/releases/download/v1.0.0/dsh-purge-community-go-1.0.0.tar.gz
mkdir -p ~/src && tar -xzf /tmp/pg.tar.gz -C ~/src && mv ~/src/dsh-purge-community-go ~/ && cd ~/dsh-purge-community-go
sh install.sh
```

`install.sh` flags:

| Flag | Effect |
|---|---|
| *(none)* | patches + native UI directory + plugin (recommended) |
| `--plugin-only` | plugin only; injection works, engine restrictions stay |
| `--dry` | scan and rehearse only; installs nothing, changes nothing |
| `--profile web` | target profile (default `web`) |

The plugin is installed **last** on purpose: `dsh plugin add` makes the host rebuild the plugin layer and is the
only step that can interrupt the running command. The other two steps are pure file operations, so a partial run
is always repairable by re-running the script.

---

## 3. Verify after install

```sh
ls -l ~/.dsh/prompt-inject.md                     # the injected body (~26 KB)
cat ~/.dsh/dsh-purge/state.json                   # "enabled": true
node patches/purge-patch.mjs probe                # tally / applicable counts
node -p 'require(process.env.HOME+"/.dsh/profiles/web/package.json").dependencies["dsh-purge-community-go"]'
```

The fastest check is the **"Purge status" capsule** above the composer: patch count, five injection rows and four
buttons live on that screen.

To prove the injection actually reaches the model:

```
/purge probe
```

Send any short message; if the model echoes the generated `purge-xxxxxxxx` verbatim, the path is live.

---

## 4. Native UI

| Surface | Behaviour |
|---|---|
| **Panel** (`status`) | one-line verdict (green/amber/red), patch metric (`applied / phone-applicable`), five injection rows, an extras line (`position · boost · probe · categories · opt-in`), four buttons, and per-status tables with a one-line "what to do" per row |
| **Buttons** | Reload / One-click inject / Toggle injection / Revert patches. Patch work is a *deferred* action (spinner up to 60 s); reload and revert are synchronous |
| **Alert strip** | appears only when something is wrong: `Purge inactive · tap to fix` / `Injection off · tap to restore` / `Purge degraded · tap to handle` |
| **Mount points** | `session.tab`, `chat.panel`, `features` |

The panel `view()` returns a **static skeleton with data bindings**; numbers are pushed from `data()` every 30 s.
Scanning 88 targets inside `view()` would run on every repaint and stall the phone.

---

## 5. Tools and commands

Eight tools: `purge_status`, `purge_apply`, `purge_revert`, `purge_prompt`, `purge_category`,
`purge_tuning`, `purge_probe`, `purge_patch_apply`.

Slash command:

```
/purge status | on | off | apply | revert | seed
/purge prompt show|set <file>|reset
/purge variant list|use <name>|default|map <model> <name|->
/purge cat list|show|on|off|add|rm|reset|bake
/purge boost on|off
/purge position head|tail|both
/purge extra <id,id|->
/purge probe [new|clear]
/purge patches [probe|apply|restore]
/purge home
```

`/purge help` prints the table.

---

## 6. The 88 patches

The table is exported from the community edition (`lib/patches/*.mjs`) into `patches/patches.json`:

- RegExp patterns are serialised as `{ source, flags }`;
- fields `markers` / `forbid` / `optional` / `surfaces` / `optIn` / `rel` are preserved;
- the community `targetFiles(aiBase)` map is extracted into `fileTargets` (**file key → package + relative path**),
  so the executor does not guess paths.

Statuses: `applied` / `hit` / `partial` / `drifted` / `miss` / `no_pkg` / `no_file` / `no_needle`.

The denominator is the **number of patches applicable to the phone**, not 88: desktop-only patches
(`surfaces: ["desktop"]`, 7 of them) and patches whose target package is absent are excluded.

Two patches are **opt-in** (#18 repeated-tool reminder, #19 tool-result pruner) and are skipped unless listed:

```
/purge extra 18,19
```

**Patches are not permanent.** Updating the App reinstalls the engine packages and wipes them. The alert strip
appears on its own; run `/purge patches apply` (or tap "One-click inject"), then restart the engine.

---

## 7. Differences from the desktop community edition

| Item | Community desktop | This package |
|---|---|---|
| Host | DSH Desktop (Electron + asar) | dsh-go (Android proot, single node process) |
| UI | Web slot panel (browser) | native dsh-go bridge |
| Patch targeting | `targetFiles(aiBase)` absolute-path table | same table exported as `fileTargets` |
| asar unpack / swap / scheduled tasks | yes | dropped (no such objects on Android) |
| Presets / Liangshen / Electron shell | supported | targets absent → `no_pkg` / desktop-only |
| Red-team console | bundled | not ported (separate project) |
| Updater (13 modules) | yes | not ported (App updates arrive as APKs) |
| Prompt body | sealed in `lib/asset-table.js` | same plaintext, re-sealed into `lib/asset-table.json` |

Module-by-module mapping and reasons: [docs/port-notes.en.md](docs/port-notes.en.md).

---

## 8. Repository layout

```
lib/                 injection core, native bridge, tools, commands
patches/             patches.json (88 entries + fileTargets), CLI, executor
scripts/             export-community-patches, reseal-prompt, build-dist, run-tests, engine-smoke, kit-check
test/                67 in-process cases
dist/                build artifacts (tar.gz / zip / SHA256SUMS / manifest)
docs/                port notes (zh + en)
```

## 9. Maintenance

```sh
node scripts/export-community-patches.mjs --community ../dsh-purge-community   # refresh the patch table
node scripts/reseal-prompt.mjs --community ../dsh-purge-community              # refresh the body
node scripts/run-tests.mjs                                                     # 67 cases
node scripts/build-dist.mjs                                                    # rebuild dist/
```

## 10. Known limits

1. Fully effective only in **new** sessions (the system prompt is written into conversation history).
2. Patches live in `node_modules`; engine/App updates wipe them.
3. `node --check` validates syntax only; where child processes are blocked it degrades to `UNVERIFIED`.
4. `partial` means "partially applied", not "effective". Health is judged by the `applied` count (< 10 = wiped).
5. Tuned for DeepSeek (ChatML envelope).

## 11. License

- This package: **AGPL-3.0**
- Patch table and prompt body: **MIT** (`LICENSE-community`)
- Provenance: `NOTICE`
