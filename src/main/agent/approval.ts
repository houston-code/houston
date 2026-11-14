import type { ApprovalPolicy } from '@shared/types'
import { parseMcpToolName } from '@shared/mcp'
import type { ToolDef, ToolKind } from './tools'

/**
 * Tools whose "Allow for run" grant is their own rather than their kind's. Each starts
 * something that keeps acting without the user: a scheduled run that fires unattended
 * for as long as the schedule exists, a background session, a writable subagent that
 * edits and runs shell commands on its own. Approving one ordinary file write is not
 * consent to any of those, so a write-kind grant must not cover them (and a grant on
 * one of them must not cover ordinary writes either).
 */
const OWN_GRANT_TOOLS: ReadonlySet<string> = new Set(['schedule_run', 'spawn_session', 'dispatch_writable_agent'])

/**
 * The key an "Allow for run" grant is recorded and checked under (RunState.override,
 * ConversationOverride.grants). One helper for both sides, so a grant always means
 * exactly what the check reads it as.
 *
 * - The tools in {@link OWN_GRANT_TOOLS}: `tool:<name>`, a grant of their own.
 * - An MCP tool (`mcp__<serverId>__<tool>`): `mcp:<serverId>`, per SERVER. Each server
 *   is a separate program the user connected for its own reasons; consenting to one
 *   server's calls never extends to another's.
 * - Everything else: its kind (`read`, `write`, `shell`, ...), as before. Network calls
 *   don't reach here: their grant is per destination (see networkDestination).
 */
export function grantKey(toolName: string, kind: ToolKind): string {
  if (OWN_GRANT_TOOLS.has(toolName)) return `tool:${toolName}`
  const mcp = parseMcpToolName(toolName)
  if (mcp) return `mcp:${mcp.serverId}`
  return kind
}

/**
 * Tools that start an agent which runs shell commands without asking, so they prompt
 * wherever shell does (every mode but full auto) even though their kind is `write`.
 * A writable subagent runs sandboxed `run_shell` on its own; in auto-edit, which asks
 * for every shell command, auto-approving the dispatch would hand the agent the shell
 * the mode withholds. Its own grant (see {@link grantKey}) or an allow rule clears it.
 */
const RUNS_SHELL_TOOLS: ReadonlySet<string> = new Set(['dispatch_writable_agent'])

/** Whether this tool starts an agent that runs shell commands unprompted (see RUNS_SHELL_TOOLS). */
export function startsShellAgent(toolName: string): boolean {
  return RUNS_SHELL_TOOLS.has(toolName)
}

/**
 * Tools that launch a new session whose first message the model writes: a background
 * session now, or one per occurrence of a schedule. That message arrives in the new
 * session as a USER turn, with no tool call behind it to show it came from outside
 * text, so in a conversation that has read outside text these are a way to launder
 * an injected instruction into a session that trusts it. See `taintedLaunch`.
 */
const LAUNCH_TOOLS: ReadonlySet<string> = new Set(['schedule_run', 'spawn_session'])

/** Whether this tool launches a session seeded with model-written text (see LAUNCH_TOOLS). */
export function launchesSession(toolName: string): boolean {
  return LAUNCH_TOOLS.has(toolName)
}

/**
 * In plan mode the agent is read-only: it researches and proposes a plan but may
 * not change anything. Writes, shell commands, MCP calls, and network tools flagged
 * `blockedInPlan` (the ones that change remote or repo state) are blocked outright
 * (not merely prompted) until the user switches off plan mode. Reads and other
 * network fetches (which don't mutate anything) are still allowed, network via its
 * usual approval prompt.
 *
 * The single source for what plan mode refuses: the loop enforces it per call, and
 * the system prompt derives its plan-mode list of refused tools from it.
 */
export function isBlockedByPlan(
  policy: ApprovalPolicy,
  tool: Pick<ToolDef, 'kind' | 'blockedInPlan'>
): boolean {
  if (policy !== 'plan') return false
  const { kind } = tool
  return kind === 'write' || kind === 'shell' || kind === 'mcp' || tool.blockedInPlan === true
}

/**
 * Decide whether a tool call must be approved by the user before it runs.
 *
 * - `override` ("Allow for run") auto-approves everything for the rest of the run.
 * - Network egress and MCP always prompt on first use — even in full-auto — because
 *   they leave the machine / run outside the sandbox. The user can still pick "Allow
 *   for run" on that prompt to stop further prompts. (The loop-level
 *   {@link decideApproval} lets full auto skip the prompt for a network call that only
 *   reads; see its `networkRead` input.)
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
  /**
   * "Allow for run" set by an earlier approval this run, under this call's
   * {@link grantKey} (or, for a network call, its destination).
   */
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
  /**
   * Whether this is a read of a credential / secret file (see isSensitivePath).
   * Defaults to false for non-read calls / ordinary files.
   */
  sensitiveRead?: boolean
  /**
   * Whether this write or shell command creates, overwrites, or removes a credential /
   * secret file (see writesSensitivePath / shellWritesSensitivePath). Defaults to false.
   */
  sensitiveWrite?: boolean
  /**
   * Whether this shell command can throw away work in the project (see
   * shellDiscardsWork: `git reset --hard`, `git clean -f`, `rm -r` of source, a forced
   * push). Defaults to false.
   */
  shellDiscardsWork?: boolean
  /**
   * Whether this network call only reads (see fullAutoNetworkRead: a GitHub read, or
   * a web read when the user allowed those), so
   * full auto runs it without the per-destination prompt. Defaults to false.
   */
  networkRead?: boolean
  /**
   * Whether this is a memory save or delete in a conversation that has taken in text
   * from outside (see memoryTaintSource). Defaults to false.
   */
  memoryTainted?: boolean
  /**
   * Whether this call launches a session seeded with model-written text (see
   * {@link launchesSession}) from a conversation that has taken in text from outside
   * (see memoryTaintSource). Defaults to false.
   */
  taintedLaunch?: boolean
  /**
   * Whether this call starts an agent that runs shell commands unprompted (see
   * {@link startsShellAgent}). Defaults to false.
   */
  startsShellAgent?: boolean
  /**
   * Whether one of the USER's own PreToolUse hooks approved this call (a project-tier
   * hook's approve never counts, and neither does any approve when a managed or
   * project `ask` rule matched: the loop passes false then). Clears only the prompt
   * the mode or a user `ask` rule would show, never a hard check (see
   * {@link ApprovalDecision.hard}). Defaults to false.
   */
  hookApproved?: boolean
}

/** What {@link decideApproval} decided for one call. */
export interface ApprovalDecision {
  mustApprove: boolean
  /** The prompt is about running unconfined shell (the card carries the warning). */
  unsandboxedShell: boolean
  /**
   * The prompt comes from a check that holds in every mode (a workspace-escaping or
   * work-discarding shell command, a credential read or write, a memory write or a
   * session launch in a conversation that took in outside text, unconfined shell
   * without the per-run unconfined consent), not from the mode or a user rule. A
   * PreToolUse hook's approve can't clear one: a hook is automation, and these checks
   * exist for the user to see the call. False when there is no prompt.
   */
  hard: boolean
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
 *
 * A read of a credential / secret file (see isSensitivePath) is the same shape of
 * risk from the read side: `read_file` never prompts, so an agent could quietly
 * pull a committed `.env` or private key into the transcript. It prompts even in
 * full-auto, cleared only by an explicit `allow` rule or a read override the user
 * granted this run (picking "allow for run" on such a prompt) — the same escape
 * hatches the workspace-escaping shell has.
 *
 * Writing one (`sensitiveWrite`: a file tool targeting `.env`, a key, a credential
 * store, or a shell command redirecting into or copying over one) prompts the same
 * way. Such files are rarely edited and only the user can restore one an agent
 * overwrote, so even full-auto asks first; an `allow` rule or "allow for run" on the
 * prompt opts out.
 *
 * A shell command that can throw away work in the project (`shellDiscardsWork`) asks in
 * every mode too. The sandbox keeps a command inside the project, but the project is what
 * `git reset --hard` or `rm -r src` destroys, and shell side effects aren't checkpointed.
 * Only an explicit `allow` rule skips it: "Allow for run" and full-auto don't, and on a
 * host without a sandbox neither does the unconfined-shell consent.
 *
 * A memory write in a conversation that has read text from outside (`memoryTainted`:
 * a web page, a GitHub body, an MCP result, a subagent's report) asks in every mode,
 * and nothing skips it: not an `allow` rule, not "Allow for run", not full auto. A
 * memory outlives the conversation and rides every later prompt, so it is where an
 * injected instruction would go to persist, and the user seeing the save is the
 * check that stops it.
 *
 * Launching a session (`taintedLaunch`: schedule_run, spawn_session) from such a
 * conversation is held to the same rule. The model writes the new session's first
 * message, which that session reads as the user's own words with no tainting call in
 * its log, and a schedule repeats it unattended. So an instruction planted in fetched
 * text could otherwise start a session that acts on it (and saves it to memory)
 * without the user ever seeing it.
 *
 * A writable subagent (`startsShellAgent`) asks wherever shell asks, every mode but
 * full auto, though its kind is `write`: it runs shell commands without asking.
 *
 * A PreToolUse hook that approves (`hookApproved`, the user's own hooks only) clears
 * the prompt the mode or a user `ask` rule would show, and nothing else: every check
 * above that holds in every mode (`hard` on the result) still asks.
 *
 * A network call that only reads (`networkRead`) runs without asking in full auto: the
 * per-destination prompt exists to stop data leaving or something being published, and
 * a GitHub list or view does neither. A permission
 * `ask` or `deny` rule still applies first, and every other policy still asks.
 */
export function decideApproval(inputs: ApprovalInputs): ApprovalDecision {
  const d = baseDecision(inputs)
  // A user hook's approve stands in for the user's click on an ordinary prompt only.
  if (d.mustApprove && inputs.hookApproved && !d.hard) return { ...d, mustApprove: false }
  return d
}

function baseDecision(inputs: ApprovalInputs): ApprovalDecision {
  const { ruleAction, policy, kind, override, shellSandboxed, shellUnsandboxedOverride } = inputs
  const ask = (hard: boolean, unsandboxedShell = false): ApprovalDecision => ({
    mustApprove: true,
    unsandboxedShell,
    hard
  })
  const pass: ApprovalDecision = { mustApprove: false, unsandboxedShell: false, hard: false }

  if (kind === 'shell' && !shellSandboxed) {
    // An `ask` rule (any tier) wins over the per-run unconfined-shell consent;
    // `unsandboxedShell` stays true so the prompt still carries the unconfined banner.
    // So does a command that discards work: consent to run unconfined isn't consent to
    // reset the project. Running unconfined at all without that consent is hard: a
    // hook's approve is automation, not the conscious consent the banner asks for.
    const hard = !!inputs.shellDiscardsWork || !shellUnsandboxedOverride
    if (ruleAction === 'ask' || inputs.shellDiscardsWork) return ask(hard, true)
    return shellUnsandboxedOverride ? { ...pass, unsandboxedShell: true } : ask(true, true)
  }
  if (inputs.memoryTainted || inputs.taintedLaunch) return ask(true)
  if (ruleAction === 'allow') return pass
  // The checks that hold in every mode, short of an allow rule (handled above).
  // A workspace-escaping shell command always prompts (a generic override or
  // full-auto doesn't cover it); so does one that can throw away work in the project.
  // A read of a credential file always prompts too, unless the user already granted
  // a read override for this run ("allow for run"); likewise a change to one.
  const hardCheck =
    (kind === 'shell' && (!!inputs.shellEscapesWorkspace || !!inputs.shellDiscardsWork)) ||
    (kind === 'read' && !!inputs.sensitiveRead && !override) ||
    ((kind === 'write' || kind === 'shell') && !!inputs.sensitiveWrite && !override)
  if (ruleAction === 'ask') return ask(hardCheck)
  if (hardCheck) return ask(true)
  if (kind === 'network' && inputs.networkRead && policy === 'full-auto') return pass
  // A writable subagent runs shell commands on its own, so it asks wherever shell does.
  if (inputs.startsShellAgent && policy !== 'full-auto' && !override) return ask(false)
  return needsApproval(policy, kind, override, shellSandboxed) ? ask(false) : pass
}
