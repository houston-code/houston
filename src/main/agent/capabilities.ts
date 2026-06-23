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
    const lines = agents.map((a) => `- ${a.name}: ${a.description}`).join('\n')
    parts.push(
      `Custom subagents available via dispatch_agent({ agent: "<name>", ... }) — each is a specialized read-only agent:\n${lines}`
    )
  }

  if (skills.length) {
    const lines = skills.map((s) => `- ${s.name}: ${s.description} (read ${s.path} for instructions)`).join('\n')
    parts.push(
      `Skills available for this project. When a task matches one, read its SKILL.md for full instructions before proceeding:\n${lines}`
    )
  }

  return parts.join('\n\n')
}
