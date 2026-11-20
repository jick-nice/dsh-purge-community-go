// 能力选用协议段：教模型「先读 skill / MCP 目录，再按当前任务选用」。
// 段名故意不带 `dsh-purge` 前缀：引擎按前缀把这类段提到最前，会让 cap 跑到 inject 前头。
import { capabilityOverrideText } from './community.js'

export const CAPABILITY_SECTION = 'dshpg-capabilities'

/** 段号紧跟注入正文之后。 */
export const CAPABILITY_ORDER = -99999

export const OFFICIAL_PROTOCOL = `## Capability selection by task (mandatory)

1. **Read first**: Inspect \`<available_skills>\` / the skill catalog and the installed MCP / host tools for this session. Know what exists before acting.
2. **Match the task**: From that catalog, pick the skill(s) and MCP/CLI tool(s) that fit *this* user task — not "always use something", not "never use something".
3. **Call what matches**:
   - Matching **Skill** → load it with the host \`skill\` tool, then follow it (methods, premises, branches, counter-evidence).
   - Matching **MCP / CLI** → call that tool with real schema and context; treat failures by the tool's semantics.
4. **Only then DIY**: If nothing in the catalog fits the task, use shell / ad-hoc steps and say what was missing.
5. **Subagents / sub-delegates inherit this rule**: Any \`subagent\`, teammate, or child agent you start must also read the catalog and call task-matched skills/MCP the same way. Put that requirement in the child brief when you dispatch.
6. Host skills and MCP stay available; this prompt does not remove them.`

/**
 * 能力协议正文：$DSH_HOME/dsh-purge/capabilities.md 覆盖 > 内置。
 * @param {{ enabled?: boolean, home?: string, text?: string }} [opts]
 */
export function capabilityProtocolText(opts = {}) {
  if (opts.enabled === false) return ''
  if (typeof opts.text === 'string') return opts.text
  if (opts.home) {
    const override = capabilityOverrideText(opts.home)
    if (override) return override
  }
  return OFFICIAL_PROTOCOL
}
