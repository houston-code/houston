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
  return policy === 'plan' && (kind === 'write' || kind === 'shell' || kind === 'mcp')
}

/**
 * Decide whether a tool call must be approved by the user before it runs.
 *
 * - `override` ("Allow for run") auto-approves everything for the rest of the run.
 * - Network egress always prompts on first use — even in full-auto — because it
 *   leaves the machine and runs outside the Seatbelt sandbox. The user can still
 *   pick "Allow for run" on that prompt to stop further network prompts.
 * - Shell auto-approval in full-auto is premised on the Seatbelt sandbox confining
 *   the command to the project. When `sandboxed` is false the sandbox is NOT in
 *   effect, so an arbitrary command would run with the user's full privileges —
 *   always prompt then, even in full-auto, rather than executing unconfined.
 *   (Reads/writes don't rely on the sandbox: the structured file tools enforce
 *   their own containment in JS, so the signal only gates shell.)
 * - Otherwise: full-auto approves everything; reads never prompt; writes prompt
 *   only under the strict "ask" policy; shell always prompts.
 */
export function needsApproval(
  policy: ApprovalPolicy,
  kind: ToolKind,
  override: boolean,
  sandboxed = true
): boolean {
  if (override) return false
  // Network egress and MCP tools always prompt (they leave the machine / run
  // outside the sandbox) — even in full-auto, unless a permission rule allows them.
  if (kind === 'network' || kind === 'mcp') return true
  // Unconfined shell is never silently auto-approved, regardless of policy.
  if (kind === 'shell' && !sandboxed) return true
  if (policy === 'full-auto') return false
  if (kind === 'read') return false
  if (kind === 'write') return policy === 'ask' // auto-edit auto-approves writes
  return true // shell
}
