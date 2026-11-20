# Port notes: dsh-purge-community → dsh-go

**English** | [简体中文](port-notes.md)

What was carried over, how, and what was left out — for whoever maintains this package.

Upstreams:

- **Content**: `dsh-purge-community` 1.7.20 (MIT) — the 88-patch table, the injection body, the runtime switches
- **Shape**: `dsh-purge-go` 0.5.6 (AGPL-3.0) — the dsh-go native bridge, the assembly waterfall, the patch executor

---

## 1. Why the community edition cannot simply be installed

The community edition targets **desktop DSH**. On dsh-go it breaks in three places:

| Break | Community approach | On dsh-go |
|---|---|---|
| Patch targeting | `targetFiles(aiBase)` returns **absolute paths** (`resources/app`, `profiles/<name>/cordis.patch.yml`, nested `dsh/node_modules/...`, desktop preset YAMLs) | none of those paths exist → most patches become `no_file` / `miss` |
| UI | Web slot (`packages/purge-panel`, served in a browser) | dsh-go is a Flutter app that **never loads web client modules** → the panel never appears |
| Host objects | `app.asar`, Electron main process, `schtasks`, the official updater | a single node process in Android proot; none of those objects exist |

So the work is not "patch a few lines": extract the **content**, then re-attach it to dsh-go's **official extension
points**.

---

## 2. Module-by-module mapping

### 2.1 Injection layer

| Community | This package | Note |
|---|---|---|
| `registerPromptSections` in `lib/index.js` | `lib/index.js` + `lib/assemble.js` | Section registration kept (head / tail / capability / boost / probe / post); reordering is done in the `system-prompt/assemble` waterfall instead of relying on host sort order |
| `lib/identity.js` (43 KB: assemble guard, slot reuse, 400 ms self-healing) | `rewriteAssembly` in `lib/assemble.js` | The phone has one host instance and no web hot reload; the waterfall reorders owned sections and drops conflicting ones without touching engine internals |
| `lib/rules.js` (workspace rules, cwd injection) | resolution order in `lib/prompt.js` | Kept: byModel variant > active variant > `prompt-inject.md` > bundled body. cwd rules dropped — on the phone cwd is the app's private directory |
| `lib/asset-table.js` (AES-256-GCM + deflate, community salt) | `lib/asset-table.json` + `lib/table-key.js` + `lib/table-read.js` | **Same plaintext**, re-sealed with this package's own salt (`scripts/reseal-prompt.mjs`) |
| `lib/boost.js` + `tuning.js: boost` | `BOOST_TEXT` / `readBoost` / `writeBoost` in `lib/community.js` | Body and semantics kept; state consolidated in `tuning.json` |
| `lib/probe.js` | probe section of `lib/community.js` | Kept: nonce, 30-minute TTL, section text |
| `lib/capability-protocol.js` | `lib/capability.js` | Generic protocol only; the red-team lead/child variants are not ported |
| `lib/refusal-retry.js` (`llm/stream` hook, retries the request) | `lib/recover.js` (from dsh-purge-go) | Lighter on the phone: append one follow-up after the turn ends; no request replay, deduplicated by `seq` |
| `lib/continue-retry.js` | not ported | Solves the same problem as `recover.js`; both would fight |
| `lib/rewind.js` (23 KB enhanced rewind) | not ported; patches #56 #58 #75 #77 kept | Rewind is a data-consistency operation; desktop-shaped implementations are riskier than they are useful on the phone |

### 2.2 Patch layer

| Community | This package | Note |
|---|---|---|
| `lib/patches/{prompt,code,engine,new-tools,opt-in,stability}.mjs` (`ALL_PATCHES`, 88) | `patches/patches.json` | Exported by `scripts/export-community-patches.mjs`: RegExp → `{ source, flags }`; `markers` / `forbid` / `optional` / `surfaces` / `optIn` / `rel` preserved |
| `targetFiles(aiBase)` in `lib/core.js` | `fileTargets` in `patches.json` | Parsed from the source: `path.join(aiBase, pkg, ...rel)` and `nestedPkg(...)`; 17 keys added via `FALLBACK_TARGETS` |
| `applyPatches` / `revertAll` / `backupAll` (asar swap, shim patching, desktop restart) | `patches/lib/core.mjs` + `patches/purge-patch.mjs` | Kept: probe / transactional apply / backup manifest / restore / `node --check`. Dropped: asar, shims, scheduled tasks, desktop restart |
| `lib/anchors.js` (drift + semi-automatic re-anchoring) | not ported | The phone panel reports status and advice; drift is handled by re-applying. For surgical work, read `node patches/purge-patch.mjs probe` |
| `lib/patch-state.mjs`, web theming | not ported | The panel is the native bridge, not the community web counting model |

**The 17 keys covered by `FALLBACK_TARGETS`:**

| Key | Resolves to | Typical scan result |
|---|---|---|
| `preset-standard` / `ptc` / `cordis` / `minimal` / `unrestricted` | `dsh-agent-presets/presets/<name>/agent.cordis.yml`, `dsh-web-app/presets/<name>.patch.yml` | `no_pkg` / `no_file` (the phone runs `dsh-base` only) |
| `agent-preset` | same (standard) | same |
| `desktop-shell` | `dsh-desktop-shell/lib/index.js` | `no_pkg` |
| `preset-liangshen` / `preset-liangshen-pkg` / `liangshen-tool-bootstrap` | user dir / third-party package | empty target → `no_pkg` (desktop-only) |
| `system-prompt-nested` / `tool-web-nested` / `hooks-*-nested` | `dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js` | only hits in npm nested layouts |
| `pi-ai-anthropic-messages` / `completions` / `responses-shared` | `../@earendil-works/pi-ai/dist/api/*.js` | usually `no_pkg` (DeepSeek only) |

### 2.3 Host adapters (all dropped)

| Module | Size | Why |
|---|---|---|
| `client.js` | 721 KB | needs `window.__ModuleLoader__` / web slots; the engine node process has no `window` |
| `packages/purge-panel/` | separate package | loaded in a browser only; dsh-go never loads web clients |
| `lib/extract-asar.js`, `windows-asar-handoff.js`, `macos-asar-handoff.js` | 49 KB | no `app.asar` on Android |
| `lib/desktop*.js` (7 modules) | ~80 KB | no Electron shell |
| `lib/hide-console.js`, `child-process-hide.mjs`, `liangshen*` | ~25 KB | no Windows console, no Liangshen preset |
| `lib/update*.js` (13 modules) | ~160 KB | App updates arrive as APKs; the plugin never self-updates |
| `lib/redteam/*` | ~1.1 MB | separate project (dsh-redteam-mode), installed on its own |
| `lib/skills.js`, `presets*.js`, `instance.js`, `host*.js` | ~90 KB | preset switching, skill import, multi-host layout detection — the phone has one layout |
| `bin/*.js` | — | desktop CLI (`purge-community status|selfcheck|...`); this package's CLI is `patches/purge-patch.mjs` |

**In one line**: of the community's 518 files / ~4.8 MB, the parts directly tied to *purging* are the
**patch table + body + runtime switches**. This package is ~50 files / ~0.5 MB; everything removed is desktop
host scaffolding.

---

## 3. dsh-go constraints learned the hard way

1. **`tools` must be in the top-level `inject` array.** Registering through `ctx.inject(['tools'], cb)` yields no
   tool table on dsh-go: the plugin loads, the capsule appears, injection works — yet the model cannot call any
   `purge_*` tool.
2. **Register native UI from the plugin's own `ctx`**, never from an `ctx.inject(['dshGo'], cb)` scoped context.
   That child fiber is destroyed when the bridge service is rebuilt, taking the registration with it (measured:
   cleared 339 ms after boot). `lib/native.js` re-arms at 1 s / 3 s / 8 s / 20 s and uses `isLive()` to avoid
   flicker.
3. **`view()` must return a static skeleton.** All numbers are pushed from `data()` (30 s). Scanning inside
   `view()` runs on every repaint and stalls the phone.
4. **Slow actions must be deferred** (`{ pending, result }`): the synchronous callback budget is 3 s, applying
   patches takes tens of seconds on a phone. Conversely, revert/toggle are millisecond-fast locally — doing them
   synchronously removes the "cancelled but reported done" race.
5. **`node --check` may be unable to spawn** (restricted sandbox / blocked exec in proot). Report `UNVERIFIED`
   instead of failing, otherwise a whole batch gets rolled back for no reason.
6. **Do not rely on `- id: system-prompt / config:` overlays.** dsh-go's assembly is not guaranteed to merge
   third-party config by id. Identity stripping happens in the waterfall instead.

---

## 4. Syncing upstream

```sh
# 1) patch table changed
node scripts/export-community-patches.mjs --community ../dsh-purge-community
node scripts/run-tests.mjs patch-table

# 2) injection body changed
node scripts/reseal-prompt.mjs --community ../dsh-purge-community
node scripts/run-tests.mjs prompt

# 3) everything
node scripts/run-tests.mjs
```

The exporter depends on two **textual** anchors in the community source:

- `lib/patches/index.mjs` → `ALL_PATCHES`
- the object literal between `export function targetFiles(` and `return filterTargetFiles(files)` in `lib/core.js`

If either is renamed upstream the exporter fails loudly instead of emitting an empty table.
