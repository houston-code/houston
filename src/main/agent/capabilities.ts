import type { CustomAgent } from './agents'
import type { Skill } from './skills'

/**
 * Format the project's custom agents and skills into a system-prompt section so
 * the model knows what's available. Agents are dispatchable by name; skills are
 * listed with their instruction path, to be read on demand (progressive
 * disclosure). Returns '' when there's nothing to advertise.
 */
export function buildCapabilities(agents: CustomAgent[], skills: Skill[]): string {
  const parts: string[] = []

  if (agents.length) {
    const lines = agents
      .map((a) => `- ${a.name}: ${a.description}${a.write ? ' [writable — can edit files & run commands]' : ''}`)
      .join('\n')
    parts.push(
      `Custom subagents:\n${lines}\n\nDispatch a read-only one with dispatch_agent({ agent: "<name>", ... }). Dispatch a [writable] one with dispatch_writable_agent({ agent: "<name>", ... }) — that call is approval-gated since it grants the subagent write access.`
    )
  }

  if (skills.length) {
    const lines = skills.map((s) => `- ${s.name}: ${s.description} (${s.path})`).join('\n')
    parts.push(
      `Skills available for this project. When a task matches one, invoke skill({ name: "<name>" }) to load its full instructions and follow them before proceeding:\n${lines}`
    )
  }

  return parts.join('\n\n')
}
