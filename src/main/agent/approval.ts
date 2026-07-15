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
 * - Network egress and MCP always prompt on first use — even in full-auto — because
 *   they leave the machine / run outside the sandbox. The user can still pick "Allow
 *   for run" on that prompt to stop further prompts.
 * - Shell auto-approval in full-auto is premised on the sandbox confining the command
 *   to the project. When `sandboxed` is false the sandbox is NOT in effect, so an
 *   arbitrary command would run with the user's full privileges — prompt then, even
 *   in full-auto, rather than executing unconfined. (Reads/writes don't rely on the
 *   sandbox: the structured file tools enforce their own containment in JS.)
 * - Otherwise: full-auto approves everything; reads never prompt; writes prompt only
 *   under the strict "ask" policy; shell always prompts.
 *
 * This is the policy primitive. The loop-level {@link decideApproval} is the stricter
 * gate that also weighs permission rules and the per-run unconfined-shell consent —
 * there, neither a generic override nor an allow-rule silently bypasses an unconfined
 * shell command.
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

/** A permission rule's verdict for a specific tool call, or null when no rule matched. */
export type RuleAction = 'allow' | 'ask' | 'deny' | null

export interface ApprovalInputs {
  /** The matched permission rule's action, or null. */
  ruleAction: RuleAction
  policy: ApprovalPolicy
  kind: ToolKind
  /** Generic "Allow for run" set by an earlier approval this run. */
  override: boolean
  /** Whether the active sandbox backend OS-confines shell execution on this host. */
  shellSandboxed: boolean
  /** Per-run consent specifically to run UNCONFINED shell ("Allow for run" on such a prompt). */
  shellUnsandboxedOverride: boolean
  /**
   * Whether this shell command references a path outside the workspace (absolute,
   * `~`, or `..`-climbing). Defaults to false for non-shell calls / clean commands.
   */
  shellEscapesWorkspace?: boolean
}

/**
 * The full approval decision for one tool call, folding in permission rules, the
 * policy, and — critically — the honest sandbox status.
 *
 * On a confining host (`shellSandboxed === true`, e.g. macOS) this is exactly the
 * prior behavior: a permission `allow` rule or a generic override skips the prompt.
 *
 * On a NON-confining host, shell is the one kind where neither a permission `allow`
 * rule nor a generic "Allow for run" (which may have been granted for an unrelated
 * tool, or authored on a machine where shell *was* sandboxed) substitutes for
 * conscious consent to run unconfined. Such a command always prompts until the user
 * grants the unconfined-shell-specific override — and a permission `ask` rule keeps
 * prompting even after that. The override is consent to run unconfined without the
 * default every-command prompt; it is not consent to skip a rule that mandates one.
 * The managed/project tiers are tighten-only (their `ask` must never be silenced by
 * any user-level state), and even a user's own `ask` rule already survives a generic
 * override on a confining host, so the unconfined-shell override gets no more power.
 *
 * A shell command that references a path *outside* the workspace defeats the same
 * project-confinement premise even on a confining host (the sandbox may still let
 * it read `/etc` or `~/.ssh`), so it always prompts — even in full-auto or under a
 * generic override — unless an explicit permission `allow` rule whitelisted it.
 */
export function decideApproval(inputs: ApprovalInputs): {
  mustApprove: boolean
  unsandboxedShell: boolean
} {
  const { ruleAction, policy, kind, override, shellSandboxed, shellUnsandboxedOverride } = inputs

  if (kind === 'shell' && !shellSandboxed) {
    // An `ask` rule (any tier) wins over the per-run unconfined-shell consent;
    // `unsandboxedShell` stays true so the prompt still carries the unconfined banner.
    if (ruleAction === 'ask') return { mustApprove: true, unsandboxedShell: true }
    return { mustApprove: !shellUnsandboxedOverride, unsandboxedShell: true }
  }
  if (ruleAction === 'allow') return { mustApprove: false, unsandboxedShell: false }
  if (ruleAction === 'ask') return { mustApprove: true, unsandboxedShell: false }
  // A workspace-escaping shell command always prompts (a generic override or
  // full-auto doesn't cover it); only an explicit allow-rule, handled above, can.
  if (kind === 'shell' && inputs.shellEscapesWorkspace) {
    return { mustApprove: true, unsandboxedShell: false }
  }
  return {
    mustApprove: needsApproval(policy, kind, override, shellSandboxed),
    unsandboxedShell: false
  }
}
