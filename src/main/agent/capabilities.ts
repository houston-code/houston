import type { CustomAgent } from './agents'
import type { Skill } from './skills'

/**
 * Format the project's custom agents and skills into a system-prompt section so
 * the model knows what's available. Agents are dispatchable by name; skills are
 * listed with their instruction path, to be read on demand (progressive
 * disclosure). `dispatchModels` — the current provider's configured model ids —
 * is advertised (when there's more than one) so the model knows what it may pass
 * as a dispatch/review `model` override without guessing ids. Returns '' when
 * there's nothing to advertise.
 */
export function buildCapabilities(
  agents: CustomAgent[],
  skills: Skill[],
  dispatchModels?: string[]
): string {
  const parts: string[] = []

  if (agents.length) {
    const lines = agents
      .map(
        (a) =>
          `- ${a.name}: ${a.description}${a.write ? ' [writable — can edit files & run commands]' : ''}${a.model ? ` [runs on ${a.model}]` : ''}`
      )
      .join('\n')
    parts.push(
      `Custom subagents:\n${lines}\n\nDispatch a read-only one with dispatch_agent({ agent: "<name>", ... }). Dispatch a [writable] one with dispatch_writable_agent({ agent: "<name>", ... }) — that call is approval-gated since it grants the subagent write access.`
    )
  }

  if (dispatchModels && dispatchModels.length > 1) {
    parts.push(
      `Models configured on this provider — usable as the \`model\` override on dispatch_agent / dispatch_writable_agent / review_changes to run delegated work on a cheaper/faster sibling: ${dispatchModels.join(', ')}`
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
