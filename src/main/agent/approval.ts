import type { ApprovalPolicy } from '@shared/types'
import type { ToolKind } from './tools'

/**
 * In plan mode the agent is read-only: it researches and proposes a plan but may
 * not change anything. Writes and shell commands are blocked outright (not merely
 * prompted) until the user switches off plan mode. Reads and network fetches
 * (which don't mutate the workspace) are still allowed, network via its usual
 * approval prompt.
 */
export function isBlockedByPlan(policy: ApprovalPolicy, kind: ToolKind): boolean {
  return policy === 'plan' && (kind === 'write' || kind === 'shell')
}

/**
 * Decide whether a tool call must be approved by the user before it runs.
 *
 * - `override` ("Allow for run") auto-approves everything for the rest of the run.
 * - Network egress always prompts on first use — even in full-auto — because it
 *   leaves the machine and runs outside the Seatbelt sandbox. The user can still
 *   pick "Allow for run" on that prompt to stop further network prompts.
 * - Otherwise: full-auto approves everything; reads never prompt; writes prompt
 *   only under the strict "ask" policy; shell always prompts.
 */
export function needsApproval(policy: ApprovalPolicy, kind: ToolKind, override: boolean): boolean {
  if (override) return false
  if (kind === 'network') return true
  if (policy === 'full-auto') return false
  if (kind === 'read') return false
  if (kind === 'write') return policy === 'ask' // auto-edit auto-approves writes
  return true // shell
}
