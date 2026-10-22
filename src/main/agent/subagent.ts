import {
  systemNoteMessage,
  type ChatMessage,
  type Provider,
  type ReasoningBlock,
  type StopReason,
  type TokenUsage,
  type ToolCall
} from '@shared/agent'
import { getTool, type ToolContext, type ToolKind } from './tools'
import { FileReadTracker } from './readCache'
import { coerceToolArgs, validateToolArgs, validationError } from './argValidation'
import {
  MAX_OUTPUT_CONTINUATIONS,
  continuationNote,
  incompleteCallResult,
  raisedOutputCap
} from './output-limit'
import { runQuarantineExtraction } from './untrusted'
import { providerStreamError, withProviderRetry } from './retry'
import { recordOriginal, recordResult, writeTargets } from './checkpoints'
import type { ShellSession } from './shell-session'
import type { EvidenceDraft } from './evidence'
import { isSandboxed } from '../sandbox'
import { isSensitiveRead } from './sensitive-paths'
import { isSensitiveWrite } from './permissions'
import {
  clipText,
  stepHint,
  SUBAGENT_CAPS,
  type SubagentBudget,
  type SubagentStatus,
  type SubagentStep
} from '@shared/subagents'
import {
  isDiscoveryTool,
  isFinalStep,
  PROGRESS_TOOLS,
  resolveBudgetLimits,
  resolveExtensionLimits,
  shouldExtend,
  shouldLand
} from './budget'
import { StallDetector, callSignature, resolveStallThresholds, type StallThresholds } from './stall'
import { estimateTokens, evictStaleToolResults } from './compaction'
import { previewWrite } from './writePreview'

/**
 * A nested subagent: the main agent delegates a scoped task to a fresh loop with
 * its own context, which investigates (and, when writable, acts) and returns a
 * synthesized report.
 *
 * Two tiers:
 * - Read-only (default): reads the project with the read tools, no approvals,
 *   can't change anything — the parent does any writing.
 * - Writable (opt-in): additionally edits files (workspace-root contained in JS) and,
 *   where the host has an OS sandbox, runs shell commands confined to the project with
 *   no shell egress. On a host with no OS sandbox a command would run unconfined, which
 *   always needs the user's per-command consent: a dispatcher that can surface an
 *   approval prompt wires `gateUnconfinedShell` and each run_shell call is propagated
 *   to the user (the main loop routes it to the UI as a normal tool approval); without
 *   the gate, run_shell is refused — fail closed. The parent grants the tier by
 *   approving the dispatch_writable_agent call; every other LOCAL tool call then runs
 *   autonomously without further prompts.
 *
 * Either tier's local calls still answer to the user's permission rules: the
 * dispatcher wires `gateLocal`, which refuses what a deny rule (any tier, managed
 * policy included) covers and prompts for what an `ask` rule covers or what reads a
 * credential file. The tier's consent replaces only the default prompts, never a
 * rule's or the sensitive-read one.
 *
 * Orthogonal to the tier, the dispatcher may also grant network access (`opts.network`):
 * it offers web_fetch/web_search and routes EVERY call through a per-destination
 * consent gate — the same prompts, rules, and grants as the main agent's own network
 * calls. Without it, subagents are local-only. A subagent's SHELL commands never get
 * network, whatever the tier.
 */

/** Tools any subagent may use — local, read-only, no network egress. */
export const SUBAGENT_TOOLS = ['read_file', 'list_dir', 'glob', 'search_files', 'ast_grep'] as const

/** Extra tools a WRITABLE subagent may use — edits + sandboxed shell (still no shell egress). */
export const SUBAGENT_WRITE_TOOLS = [
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'run_shell'
] as const

/**
 * Network tools a subagent may use — offered ONLY when the dispatcher wires the
 * `network` consent seam, since every call is propagated to the user for
 * per-destination approval. Deliberately excludes view_localhost (needs the
 * Electron capture backend) and the GitHub tools (remote/PR state stays the main
 * agent's job).
 */
export const SUBAGENT_NETWORK_TOOLS = ['web_fetch', 'web_search'] as const

/**
 * Resolve the tool names a subagent may use. The base set is read-only, plus the
 * write/shell tools when `writable` and the web tools when the dispatcher wired
 * network consent. A custom agent's declared `tools` can only *narrow* that base —
 * any name outside it is dropped, and an absent/empty list falls back to the full
 * base. So a read-only agent can never gain write tools, and no agent can reach
 * past what its dispatcher granted.
 *
 * A declared list that names something but nothing in the tier's base (e.g. only
 * unrecognized names) fails CLOSED to the read-only tools — never back to the full
 * write+shell base — so a typo'd or stale `tools:` list can't silently grant MORE
 * privilege than it named, the opposite of the author's narrowing intent.
 */
function resolveSubAgentTools(
  allowed: string[] | undefined,
  writable: boolean,
  network: boolean
): readonly string[] {
  const base: readonly string[] = [
    ...SUBAGENT_TOOLS,
    ...(writable ? SUBAGENT_WRITE_TOOLS : []),
    ...(network ? SUBAGENT_NETWORK_TOOLS : [])
  ]
  if (!allowed?.length) return base
  const narrowed = base.filter((t) => allowed.includes(t))
  return narrowed.length ? narrowed : SUBAGENT_TOOLS
}

/**
 * How deep dispatches may nest: the main agent (depth 0) can dispatch subagents
 * (depth 1), which can dispatch their own read-only researchers (depth 2), and
 * that's the floor — a depth-2 agent gets no dispatch tool. Enforced by the loop,
 * which only injects `dispatchNested` for agents above the floor.
 */
export const MAX_SUBAGENT_DEPTH = 2

/** Tier-specific constraints + reporting contract, shared by the default and custom agents. */
function subAgentConstraints(
  workspace: string,
  writable: boolean,
  shellSandboxed: boolean,
  shellGated: boolean,
  network: boolean
): string {
  let capabilities: string
  if (!writable) {
    capabilities = `You are working inside the project at ${workspace}. You can only read: read_file, list_dir, glob, search_files, ast_grep. You cannot edit files or run commands.`
  } else if (shellSandboxed) {
    capabilities = `You are working inside the project at ${workspace}. You can read (read_file, list_dir, glob, search_files, ast_grep) and make changes: edit files (write_file, edit_file, multi_edit, apply_patch) and run shell commands (run_shell). Edits and commands are confined to the project sandbox: you cannot write outside the workspace, and your shell commands cannot reach the network.`
  } else if (shellGated) {
    // No OS sandbox, but the dispatcher wired a consent gate: each command is
    // propagated to the user as an approval prompt before it runs unconfined.
    capabilities = `You are working inside the project at ${workspace}. You can read (read_file, list_dir, glob, search_files, ast_grep) and make changes: edit files (write_file, edit_file, multi_edit, apply_patch), confined to the project, and run shell commands (run_shell, which cannot reach the network). This host has no OS sandbox, so each run_shell command first asks the user for approval. That happens automatically when you call it, and a denial comes back as the tool result. Prefer edits over commands, batch related commands into one call where reasonable, and if a command is denied do not retry it: work around it or note it in your report.`
  } else {
    // No OS sandbox and no consent gate, so run_shell is refused (see runSubAgent):
    // without a gate a background subagent can't prompt for the consent an
    // unconfined command needs.
    capabilities = `You are working inside the project at ${workspace}. You can read (read_file, list_dir, glob, search_files, ast_grep) and edit files (write_file, edit_file, multi_edit, apply_patch), confined to the project. This host has no OS sandbox, so run_shell is not available to you: make the edits you can and note in your report anything that still needs a command run (the main agent can run it with approval).`
  }
  const egress = network
    ? `You can also fetch public URLs with web_fetch and search the web with web_search. Each network request first asks the user for approval (automatically, when you call the tool) unless they already granted that destination; a denial comes back as the tool result; do not retry a denied request.`
    : `You have no network access.`
  return `${capabilities} ${egress}

Your final message is your entire report back to the calling agent, so make it self-contained. Lead with the outcome (the answer, or what you changed and whether its checks passed), then the specifics the caller needs: file paths with line numbers, key code, and anything you could not confirm or did not finish. Don't narrate your steps. Be concise.`
}

function subAgentSystemPrompt(
  workspace: string,
  writable: boolean,
  shellSandboxed: boolean,
  shellGated: boolean,
  network: boolean
): string {
  const role = writable
    ? `You are an implementation subagent. Another agent has delegated a focused task to you. Carry it out end to end: read the code you will change, make the edits, and, where you can run commands, confirm they work with the project's own checks. Then report what you did. Stay within the task you were given, match the style of the surrounding code, and leave alone any changes you didn't make.`
    : `You are a research subagent. Another agent has delegated a focused question to you. Investigate efficiently: locate code with search_files, glob, or ast_grep before reading, and batch independent calls into one reply. Ground every claim in code you actually read, and say plainly what you could not find or confirm. Then answer the question directly.`
  return `${role}

${subAgentConstraints(workspace, writable, shellSandboxed, shellGated, network)}`
}

export interface SubAgentOptions {
  provider: Provider
  model: string
  workspace: string
  /** The task/question delegated to the subagent. */
  prompt: string
  signal: AbortSignal
  /** A custom agent's system prompt to use instead of the default one. */
  systemOverride?: string
  /**
   * A custom agent's declared tool allow-list. Intersected with the tier's tools,
   * so it can only narrow the set, never expand it. Absent/empty => the full tier.
   */
  tools?: string[]
  /**
   * Grant the write tier: the subagent may edit files and run shell commands
   * (sandboxed, no network). Default false keeps it read-only.
   */
  writable?: boolean
  /** Allowed roots for edits (workspace + added dirs). Defaults to [workspace]. */
  roots?: string[]
  /**
   * Record the subagent's file edits in this run's checkpoint (the dispatching
   * turn's), so reverting/redoing the parent turn covers delegated changes too.
   * Absent => edits aren't checkpointed (read-only tiers have nothing to record).
   */
  checkpointRunId?: string
  /**
   * Whether the host OS-confines shell execution. Defaults to the live sandbox status.
   * When false, the writable tier's `run_shell` needs per-command consent: it is routed
   * through `gateUnconfinedShell` when wired, and refused otherwise. Injected for testing.
   */
  shellSandboxed?: boolean
  /**
   * Per-command consent seam for `run_shell` on a host with NO OS sandbox, where the
   * command would run unconfined. Wired by a dispatcher that can surface an approval
   * prompt (the main loop propagates it to the user as a normal tool approval). Called
   * with the call's arguments and a thunk that executes it; resolves with the
   * tool-result text — the command's output when consent was given (the gate runs the
   * thunk), or a refusal note when it wasn't. Absent => run_shell is refused on such
   * hosts (fail closed: a dispatcher that can't prompt can't consent). Never consulted
   * on a confining host.
   */
  gateUnconfinedShell?: (
    args: Record<string, unknown>,
    run: () => Promise<string>
  ) => Promise<string>
  /**
   * Network access, granted only by a dispatcher that can surface approval prompts.
   * Presence offers {@link SUBAGENT_NETWORK_TOOLS} and routes EVERY call to them
   * through `gate`, which propagates it to the user for per-destination consent
   * (the loop mirrors its own network gating: deny rules refuse without a prompt,
   * an allow rule or an already-granted destination skips it, and a denial comes
   * back as the tool result). `getSecret`/`searchProvider` feed web_search its key;
   * `collectSecrets` feeds egress credential masking, so a subagent fetch refuses
   * to transmit a stored secret exactly like the main loop's. Absent => no network
   * tools are offered and the tiers stay local-only (fail closed: a dispatcher that
   * can't prompt can't consent).
   */
  network?: {
    gate: (
      name: string,
      args: Record<string, unknown>,
      run: () => Promise<string>
    ) => Promise<string>
    getSecret?: (id: string) => string | null
    searchProvider?: string
    collectSecrets?: () => string[]
  }
  /**
   * Permission gate for every LOCAL tool call: reads, edits, and shell on a confining
   * host (unconfined shell and network have their own seams above). The dispatcher
   * applies the same permission rules as the main loop, in the same tier order
   * (managed policy, project guardrails, the user's rules, trusted project allows),
   * plus the sensitive-read check: a deny refuses without a prompt, and an `ask` rule
   * or a read of a credential file is propagated to the user as an approval. Called
   * with the call's name, kind, and arguments and a thunk that executes it; resolves
   * with the tool-result text (the output, or a refusal note).
   *
   * Absent => there are no rules to apply, so local calls run as before, EXCEPT a
   * credential-file read, which is refused (fail closed: a dispatcher that can't
   * prompt can't consent to it).
   */
  gateLocal?: (
    name: string,
    kind: ToolKind,
    args: Record<string, unknown>,
    run: () => Promise<string>
  ) => Promise<string>
  /**
   * Report what the subagent's tools executed to the dispatching run's evidence ledger
   * (its shell commands' real exit codes), so the parent turn's receipt covers delegated
   * work. Wired by the loop for the writable tier; absent, nothing is recorded.
   */
  recordEvidence?: (e: EvidenceDraft) => void
  /** Report the paths the subagent's write tools changed, for the same receipt. */
  recordFiles?: (paths: string[]) => void
  /** Persistent shell state for run_shell (writable tier). */
  shellSession?: ShellSession
  /** Cap on a single shell command's output kept in a tool result. */
  shellOutputMaxBytes?: number
  /**
   * Scrub secrets from each tool output before it enters the subagent's transcript
   * (which ships to the provider on the next iteration) — the same seam the main
   * loop's flushResult covers for its own tool results. Because the model never
   * receives the plaintext, the subagent's report is transitively clean too. The
   * loop wires its run-scoped redactor (see redact.ts) here; defaults to identity.
   */
  redact?: (text: string) => string
  /** Called with each turn's token usage, so callers (e.g. a review) can total cost. */
  onUsage?: (usage: TokenUsage) => void
  /**
   * Send `cache_control` breakpoints on OpenAI-compatible requests (see
   * `ChatRequest.explicitCacheControl`). The caller gates this per route; a
   * subagent loop re-reads its prefix every iteration, so it benefits the same
   * way the main loop does.
   */
  explicitCacheControl?: boolean
  /**
   * Called with a short line per step (turn counter + what the tool is doing) so
   * the caller can surface live progress — without it, a long dispatch is silent
   * until its final report and reads as a stall in the parent's UI.
   */
  onProgress?: (message: string) => void
  /**
   * Resume: the transcript of a previous run of this agent. `prompt` is appended
   * as the next user turn, so the agent answers the follow-up with its earlier
   * context (files it read, conclusions it reached) intact.
   */
  priorMessages?: ChatMessage[]
  /**
   * Called with the complete message log when the run ends cleanly (final answer,
   * or step limit — both leave every tool call paired with its result). The caller
   * stores it to make the agent resumable. NOT called after an abort or provider
   * error, whose transcript may end mid-tool-call and can't be replayed into a
   * provider request.
   */
  onTranscript?: (messages: ChatMessage[]) => void
  /**
   * Dispatch a nested read-only research subagent (injected by the loop, which
   * enforces {@link MAX_SUBAGENT_DEPTH}). When present, the `dispatch_agent` tool
   * is offered to this subagent so it can fan out focused sub-searches; always
   * read-only regardless of this agent's own tier, so nesting never widens write
   * authority.
   */
  dispatchNested?: (
    prompt: string,
    agentName?: string,
    model?: string,
    /** The calling agent's step that dispatched it, so its record can point at the child. */
    stepIndex?: number,
    /** The dispatch's short label. */
    description?: string
  ) => Promise<string>
  /**
   * The step budget. Unset fields take the main loop's defaults: `maxIterations` steps
   * (DEFAULT_MAX_ITERATIONS), extended in `maxIterations`-sized chunks while the agent
   * is still making progress, up to `ceiling`. `hardCap` (a custom agent's `max_turns`)
   * replaces all of that with a fixed limit that never extends. Either way the agent
   * is reminded to wrap up near the end, and its last step can't run tools, so it
   * always ends on a report.
   */
  budget?: { maxIterations?: number; autoExtend?: boolean; ceiling?: number; hardCap?: number }
  /** Loop detection, as in the main loop. Unset: on with default thresholds; `false`: off. */
  stall?: false | Partial<StallThresholds>
  /**
   * The model's context window in tokens. When set, stale large tool results are
   * stubbed out of the request once it nears the window (see evictStaleToolResults),
   * so a long run doesn't overflow. The agent's own transcript keeps them.
   */
  contextWindow?: number
  /**
   * Called as each step starts and again when it finishes (same `index`), with what
   * the agent said, each tool call and its outcome, and notices from Houston. Strings
   * are redacted with `redact`. Writes carry their real diff when computed.
   */
  onStep?: (step: SubagentStep) => void
  /** Called once, before the first step, with the system prompt and tools the agent runs with. */
  onStart?: (info: { system: string; tools: string[] }) => void
  /** Called once, when the agent stops, with how it ended and the budget it used. */
  onEnd?: (end: { status: SubagentStatus; budget: SubagentBudget }) => void
}

/** The note pushed before a subagent's last step: its tools won't run, so report now. */
export const SUBAGENT_FINAL_STEP_NOTE =
  'This is your last step: tool calls made now will NOT run. Write your report now, in plain ' +
  'text: what you found or changed, the specifics the caller needs, and what you did not get to.'

/** The one-time reminder as a subagent nears its step limit. */
export function subagentLandingReminder(stepsLeft: number): string {
  const n = Math.max(0, stepsLeft)
  return (
    `You have about ${n === 1 ? '1 step' : `${n} steps`} left. Wrap up: finish what you are ` +
    'doing and write your report. Do not start anything you cannot complete.'
  )
}

/** Share of the context window at which stale tool results are stubbed out of the request. */
const SUBAGENT_EVICT_AT = 0.6

/** Run a subagent loop to completion and return its final report text. */
export async function runSubAgent(opts: SubAgentOptions): Promise<string> {
  const { provider, model, workspace, prompt, signal } = opts
  const writable = opts.writable === true
  // Whether this host OS-confines shell. When it doesn't, an unconfined command
  // never runs without the user's consent — the main loop's invariant. A dispatcher
  // that can surface an approval prompt wires gateUnconfinedShell to obtain that
  // consent per command; without the gate, run_shell is refused below (fail closed).
  const shellSandboxed = opts.shellSandboxed ?? isSandboxed()
  const shellGated = !shellSandboxed && opts.gateUnconfinedShell !== undefined
  const network = opts.network !== undefined
  const redact = opts.redact ?? ((t: string): string => t)
  const allowedTools = resolveSubAgentTools(opts.tools, writable, network)
  const allowedToolSet = new Set<string>(allowedTools)
  const tools = allowedTools.map((name) => getTool(name)!.schema)
  // Nested dispatch: offered as a separate capability, not part of the narrowable
  // tier base, so a custom agent's `tools:` list can't accidentally strip it and
  // — more importantly — can never *grant* it (only the loop injects the handler,
  // which enforces the depth cap and the read-only nested tier).
  if (opts.dispatchNested) tools.push(getTool('dispatch_agent')!.schema)
  // A custom agent's prompt still gets the tier constraints appended.
  let system = opts.systemOverride
    ? `${opts.systemOverride}\n\n${subAgentConstraints(workspace, writable, shellSandboxed, shellGated, network)}`
    : subAgentSystemPrompt(workspace, writable, shellSandboxed, shellGated, network)
  if (opts.dispatchNested) {
    system += `\n\nYou may also delegate a focused read-only sub-search to your own nested subagent via dispatch_agent, useful to explore several areas in parallel without filling your context. Nested agents are always read-only and cannot dispatch further.`
  }
  opts.onStart?.({ system, tools: tools.map((t) => t.name) })
  // Tool-execution context. Reads default their roots to [workspace]; the writable
  // tier passes the real roots (for edits) and a shell session. `allowNetwork` stays
  // false: it is the SHELL sandbox's egress switch, and a subagent's commands never
  // get network — web egress goes only through the consent-gated network tools.
  // NOTE: a confined shell can still READ outside the workspace (the sandbox is a
  // write/network jail, not a read one). We accept that here: without shell egress a
  // read can't leave the machine, its file writes stay contained to `roots`, and the
  // web tools mask credentials on the way out (see collectSecrets).
  const roots = opts.roots ?? [workspace]
  const toolCtx: ToolContext = {
    workspace,
    roots,
    allowNetwork: false,
    signal,
    // The subagent's own record of what it has read: it must read a file before
    // changing it, like the main agent, and what the parent read doesn't count.
    fileTracker: new FileReadTracker(),
    ...(opts.shellSession ? { shellSession: opts.shellSession } : {}),
    ...(opts.shellOutputMaxBytes ? { shellOutputMaxBytes: opts.shellOutputMaxBytes } : {}),
    ...(opts.recordEvidence ? { recordEvidence: opts.recordEvidence } : {}),
    // Network-tool plumbing (web_search key lookup, egress credential masking) —
    // only meaningful when the network tools are offered at all.
    ...(opts.network?.getSecret ? { getSecret: opts.network.getSecret } : {}),
    ...(opts.network?.searchProvider ? { searchProvider: opts.network.searchProvider } : {}),
    ...(opts.network?.collectSecrets ? { collectSecrets: opts.network.collectSecrets } : {}),
    // A subagent fetches the same untrusted web as the main loop, so it isolates
    // flagged pages the same way, on its own provider/model. Without this it would
    // silently fall back to fencing alone — the weaker path — while holding tools.
    ...(opts.network
      ? {
          quarantineExtract: ({
            content,
            source,
            query
          }: {
            content: string
            source: string
            query?: string
          }) =>
            runQuarantineExtraction({
              provider: opts.provider,
              model: opts.model,
              content,
              source,
              query,
              signal
            })
        }
      : {})
  }
  // A resumed agent continues its prior transcript; the new prompt is the next
  // user turn. Copied so the caller's stored transcript isn't mutated mid-run.
  const messages: ChatMessage[] = opts.priorMessages
    ? [...opts.priorMessages, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  let lastText = ''
  // Output-limit recovery, as in the main loop (see output-limit.ts): after a reply hits
  // the limit, later requests ask for the model's full ceiling, and a cut-off answer is
  // continued. `carried` holds the text of the continued turns, since the report is the
  // whole answer, not just its last piece.
  let outputCapRaised = false
  let outputContinuations = 0
  let carried = ''

  // The step budget: the main loop's adaptive one (a base cap that grows while the run
  // is productive, up to a ceiling), or a custom agent's fixed `max_turns`.
  const hardCap = opts.budget?.hardCap
  const budget = resolveBudgetLimits({
    maxIterations: hardCap ?? opts.budget?.maxIterations,
    landingMargin: 2
  })
  const extension = resolveExtensionLimits(budget, {
    autoExtend: hardCap === undefined && opts.budget?.autoExtend !== false,
    ceiling: opts.budget?.ceiling
  })
  const budgetUsed = (used: number): SubagentBudget => ({
    used,
    limit: budget.maxIterations,
    ceiling: extension.enabled ? extension.ceiling : budget.maxIterations,
    ...(hardCap !== undefined ? { hardCap } : {})
  })
  // Progress signals for the extension decision, as the main loop keeps them.
  const writeIterations = new Set<number>()
  const discoveryIterations = new Set<number>()
  const discoveryCalls = new Set<string>()
  let lastStallNudge: number | null = null
  let landed = false
  const stall =
    opts.stall === false ? null : new StallDetector(resolveStallThresholds(opts.stall || undefined))
  let turnsTaken = 0

  // Steps for the caller's record. Indexes are assigned here, in order.
  let nextStep = 0
  const step = (s: Omit<SubagentStep, 'index'>, index = nextStep++): number => {
    if (opts.onStep) {
      // What the agent said keeps more room than a tool's one-line label.
      const cap = s.kind === 'text' ? SUBAGENT_CAPS.stepOutput : SUBAGENT_CAPS.stepSummary
      const summary = clipText(redact(s.summary), cap).text
      opts.onStep({ ...s, summary, index })
    }
    return index
  }
  const notice = (iter: number, text: string): void => {
    step({ turn: iter + 1, kind: 'notice', summary: text })
  }

  // Clean-completion exit: hand the transcript back (for resumability) and return.
  const finish = (text: string, status: SubagentStatus = 'done'): string => {
    opts.onTranscript?.(messages)
    opts.onEnd?.({ status, budget: budgetUsed(turnsTaken) })
    return text
  }
  const stop = (text: string, status: SubagentStatus): string => {
    opts.onEnd?.({ status, budget: budgetUsed(turnsTaken) })
    return text
  }

  // The tool's one-line label (the same short form the main transcript shows).
  const labelFor = (call: { name: string; arguments: Record<string, unknown> }): string => {
    try {
      return getTool(call.name)?.summarize(call.arguments) ?? call.name
    } catch {
      return call.name
    }
  }

  // One live-progress line per tool call, plus the step number, so a caller that only
  // reads progress lines still sees what the agent is doing and how far along it is.
  const progress = (iter: number, call: { name: string; arguments: Record<string, unknown> }): void => {
    opts.onProgress?.(`step ${iter + 1} · ${labelFor(call)}`)
  }

  // The request window: the transcript, with stale large tool results stubbed once it
  // nears the model's context window. The transcript itself (and so a resume) keeps them.
  const toolTokens = Math.ceil(JSON.stringify(tools).length / 4)
  const requestMessages = (): ChatMessage[] => {
    if (!opts.contextWindow) return messages
    const size = estimateTokens(system, messages) + toolTokens
    return size > opts.contextWindow * SUBAGENT_EVICT_AT ? evictStaleToolResults(messages) : messages
  }

  for (let iter = 0; iter < budget.maxIterations; iter++) {
    if (signal.aborted) return stop(lastText.trim() || '[subagent aborted]', 'aborted')

    // A run still making progress gets more room instead of a wrap-up reminder.
    const ext = shouldExtend(
      { iteration: iter, writeIterations, discoveryIterations, lastStallNudge, alreadyLanded: landed },
      budget,
      extension
    )
    if (ext.extend) {
      budget.maxIterations = ext.maxIterations
      notice(iter, `Still making progress, so the step limit grew to ${ext.maxIterations} (at most ${extension.ceiling})`)
    }
    const landing = shouldLand({ iteration: iter, costUsd: 0, alreadyLanded: landed }, budget)
    if (landing.land) {
      landed = true
      messages.push(systemNoteMessage(subagentLandingReminder(landing.iterationsLeft)))
    }
    // The last step can't run tools, so the agent spends it on its report.
    const finalStep = isFinalStep(iter, budget)
    if (finalStep) messages.push(systemNoteMessage(SUBAGENT_FINAL_STEP_NOTE))

    let text = ''
    let calls: ToolCall[] = []
    // Widened by the cast: it's assigned inside the retry callback, which narrowing can't see.
    let stopReason = 'end_turn' as StopReason
    // The turn's replayable reasoning state (signed thinking, encrypted reasoning,
    // function-call thought signatures), kept on the transcript like the main loop
    // does: some models reject the next request of a tool loop without it.
    let reasoning: ReasoningBlock[] = []
    try {
      // One turn of the subagent's own loop, retried on a transient failure, including
      // one that drops partway through the stream. Retrying the whole turn is safe here
      // even though the parent run streams: a subagent's text and tool calls are
      // accumulated and only acted on once the stream ends, so a failed attempt has
      // shown the user nothing to retract (the main loop's `turn_discarded`) and run no
      // tool. Reset the accumulators per attempt or a retry would append to the dead
      // one's remains. There is no fallback hop: a subagent runs on the model it was
      // dispatched with.
      await withProviderRetry(
        async () => {
          text = ''
          calls = []
          stopReason = 'end_turn'
          reasoning = []
          for await (const ev of provider.streamChat({
            model,
            system,
            messages: requestMessages(),
            tools,
            ...(outputCapRaised ? raisedOutputCap(model) : {}),
            ...(opts.explicitCacheControl ? { explicitCacheControl: true } : {}),
            signal
          })) {
            if (ev.type === 'text') text += ev.text
            else if (ev.type === 'tool_call') calls.push(ev.call)
            else if (ev.type === 'done') {
              stopReason = ev.stopReason
              if (ev.usage) opts.onUsage?.(ev.usage)
              if (ev.reasoning?.length) reasoning = ev.reasoning
            } else if (ev.type === 'error') throw providerStreamError(ev)
          }
        },
        {
          signal,
          // Otherwise a subagent riding out a blip is indistinguishable from a hung one.
          onRetry: (n) => {
            opts.onProgress?.(`step ${iter + 1} · retrying (${n})`)
            notice(iter, `The model request failed; retrying (${n})`)
          }
        }
      )
    } catch (e) {
      if (signal.aborted) return stop(lastText.trim() || '[subagent aborted]', 'aborted')
      return stop(`[subagent error: ${(e as Error).message}]`, 'error')
    }
    turnsTaken = iter + 1

    // On the last step any tool call is dropped (the note said they won't run), so the
    // transcript ends on text and stays valid to resume.
    const droppedCalls = finalStep && calls.length > 0
    if (droppedCalls) calls = []

    const outputLimited = stopReason === 'max_tokens'
    if (outputLimited) outputCapRaised = true
    else outputContinuations = 0

    const answer = carried + text
    if (answer.trim()) lastText = answer
    // A cut-off answer with no text at all isn't kept: an empty assistant turn is one some
    // providers reject, and the continuation note carries on from the previous turn.
    const continueCutOff =
      calls.length === 0 &&
      outputLimited &&
      outputContinuations < MAX_OUTPUT_CONTINUATIONS &&
      iter + 1 < budget.maxIterations
    // An empty assistant turn is one some providers reject, so a last step that only
    // tried to call tools leaves nothing behind but the note before it.
    if ((!continueCutOff && !(droppedCalls && !text.trim())) || text.trim()) {
      messages.push({
        role: 'assistant',
        content: text,
        ...(calls.length ? { toolCalls: calls } : {}),
        ...(reasoning.length ? { reasoning } : {})
      })
    }

    if (continueCutOff) {
      outputContinuations++
      carried = answer
      messages.push(systemNoteMessage(continuationNote(text.trim() !== '')))
      opts.onProgress?.(`step ${iter + 1} · continuing past the output limit`)
      notice(iter, 'Reply hit the output limit; continuing it')
      continue
    }

    if (calls.length === 0) {
      if (droppedCalls) {
        const report = answer.trim() || lastText.trim()
        return finish(
          report
            ? `${report}\n\n[subagent stopped at its step limit; this is what it had]`
            : '[subagent reached its step limit without a final answer]',
          'step-limit'
        )
      }
      const report = answer.trim() || '[subagent returned no answer]'
      return finish(
        outputLimited ? `${report}\n\n[subagent report cut off at the model's output limit]` : report
      )
    }
    // The continued text was an interim message ahead of these calls, not the report.
    carried = ''
    if (text.trim()) step({ turn: iter + 1, kind: 'text', summary: text.trim() })

    const iterErrors: string[] = []
    for (const call of calls) {
      progress(iter, call)
      const startedAt = Date.now()
      const stepIndex = step({ turn: iter + 1, kind: 'tool', tool: call.name, summary: labelFor(call), startedAt })
      const tool = allowedToolSet.has(call.name) ? getTool(call.name) : undefined
      // The real diff of a write, computed before it runs (the "before" is gone after).
      const preview =
        opts.onStep && tool?.kind === 'write' && !call.incomplete
          ? await previewWrite(call.name, call.arguments, roots)
          : null
      // The schema the call is checked against: the tool's own, or the nested-dispatch
      // tool's when that capability is wired. Unknown and unavailable tools are refused
      // below and have nothing to check.
      const schema =
        call.name === 'dispatch_agent' && opts.dispatchNested
          ? getTool('dispatch_agent')?.schema.parameters
          : tool?.schema.parameters
      // Fix obvious argument-shape slips first, as the main loop does, so validation and
      // execution see the same corrected arguments the transcript records.
      if (schema && !call.incomplete) call.arguments = coerceToolArgs(call.arguments, schema)
      const issues = schema && !call.incomplete ? validateToolArgs(call.arguments, schema) : []
      let output: string
      // Whether the call did what it was asked; refusals and errors don't.
      let ok = true
      if (call.incomplete) {
        // The arguments didn't arrive whole: nothing can run, but the call is answered.
        output = incompleteCallResult(call, outputLimited)
        ok = false
      } else if (schema && issues.length) {
        output = validationError(call.name, schema, issues)
        ok = false
      } else if (call.name === 'dispatch_agent' && opts.dispatchNested) {
        // Nested dispatch is handled here (not via toolCtx) so the loop's injected
        // handler — which carries the depth cap and the read-only nested tier —
        // is the only path to it.
        const nestedPrompt =
          typeof call.arguments.prompt === 'string' ? call.arguments.prompt.trim() : ''
        const agentName =
          typeof call.arguments.agent === 'string' && call.arguments.agent
            ? call.arguments.agent
            : undefined
        const nestedModel =
          typeof call.arguments.model === 'string' && call.arguments.model
            ? call.arguments.model
            : undefined
        if (call.arguments.resume !== undefined && call.arguments.resume !== null) {
          output =
            'resume is not available from within a subagent; dispatch a fresh nested agent instead.'
          ok = false
        } else if (!nestedPrompt) {
          output = 'prompt is required.'
          ok = false
        } else {
          const description =
            typeof call.arguments.description === 'string' && call.arguments.description.trim()
              ? call.arguments.description.trim()
              : undefined
          output = await opts.dispatchNested(nestedPrompt, agentName, nestedModel, stepIndex, description)
          ok = !/^\[subagent (error|aborted)/.test(output)
        }
      } else if (!tool) {
        output = writable
          ? `Tool not available to this subagent: ${call.name}`
          : `Tool not available to a read-only subagent: ${call.name}`
        ok = false
      } else if (call.name === 'run_shell' && !shellSandboxed) {
        // On a host with no OS sandbox the command would run UNCONFINED, which the
        // main loop never does without the user's consent. With a gate wired, ask:
        // the dispatcher surfaces the approval prompt and runs the thunk only on a
        // yes (the gate's resolution — output or refusal — is the tool result).
        // Without a gate, fail closed: refuse the command; the subagent can still
        // edit files (path-contained in JS on every OS) and report what remains.
        if (opts.gateUnconfinedShell) {
          try {
            output = await opts.gateUnconfinedShell(call.arguments, () =>
              tool.execute(call.arguments, toolCtx)
            )
          } catch (e) {
            output = `Error: ${(e as Error).message}`
            ok = false
          }
        } else {
          output =
            'run_shell is unavailable to a subagent on this host: it has no OS-enforced sandbox, so the ' +
            'command would run unconfined, and a background subagent cannot prompt for the required consent. ' +
            'Make the edits you can and note what still needs a command; the main agent can run it with approval.'
          ok = false
        }
      } else if (tool.kind === 'network') {
        // Every network call is egress and goes through the dispatcher's consent
        // gate — per destination, mirroring the main loop. The tool is only offered
        // when opts.network is wired, but a model may still name it unprompted;
        // without a gate there is no way to ask, so refuse (fail closed).
        if (opts.network) {
          try {
            output = await opts.network.gate(call.name, call.arguments, () =>
              tool.execute(call.arguments, toolCtx)
            )
          } catch (e) {
            output = `Error: ${(e as Error).message}`
            ok = false
          }
        } else {
          output = `Tool not available to this subagent: ${call.name} (no network access).`
          ok = false
        }
      } else {
        // Snapshot write targets into the dispatching turn's checkpoint, exactly
        // as the main loop does for its own write tools, so "revert" covers the
        // subagent's edits. (Shell side effects aren't checkpointed here — the
        // main loop doesn't checkpoint run_shell either.) Inside the thunk, so a
        // call the gate refuses leaves no checkpoint entry behind.
        const cpRunId = tool.kind === 'write' ? opts.checkpointRunId : undefined
        const targets = cpRunId ? writeTargets(call.name, call.arguments) : []
        let ran = false
        const runLocal = async (): Promise<string> => {
          for (const t of targets) await recordOriginal(cpRunId!, roots, t.path)
          const out = await tool.execute(call.arguments, toolCtx)
          for (const t of targets) {
            await recordResult(cpRunId!, roots, t.path, { expectAbsent: t.deleted })
          }
          // Reached only when the write landed (a failed one throws above).
          if (tool.kind === 'write' && opts.recordFiles) {
            opts.recordFiles(writeTargets(call.name, call.arguments).map((t) => t.path))
          }
          ran = true
          return out
        }
        try {
          if (opts.gateLocal) {
            // The dispatcher's permission rules and sensitive-read prompt, the same
            // checks the main loop runs before any call of its own.
            output = await opts.gateLocal(call.name, tool.kind, call.arguments, runLocal)
          } else if (isSensitiveRead(tool.kind, call.arguments)) {
            output =
              `Reading ${String(call.arguments.path)} needs the user's approval because it looks like a ` +
              'credential or secret file, and this subagent cannot ask for it. Do not retry; note in ' +
              'your report that the main agent can read it with approval if it is needed.'
          } else if (isSensitiveWrite(tool.kind, call.name, call.arguments)) {
            output =
              "This call changes a credential or secret file (such as .env), which needs the user's " +
              'approval, and this subagent cannot ask for it. Do not retry; note in your report what ' +
              'should change so the main agent can make the change with approval.'
          } else {
            output = await runLocal()
          }
        } catch (e) {
          output = `Error: ${(e as Error).message}`
        }
        // A refusal by a rule or the user comes back as text without running the call.
        ok = ran
      }
      // Strip secrets here at the single choke point every tool output passes through
      // (execution results, errors, and refusal notes alike) — mirroring the main
      // loop's flushResult — so the provider never sees the plaintext.
      const clean = redact(output)
      messages.push({ role: 'tool', content: clean, toolCallId: call.id, toolName: call.name })

      if (!ok) iterErrors.push(clean)
      if (ok && PROGRESS_TOOLS.has(call.name)) writeIterations.add(iter)
      if (ok && isDiscoveryTool(call.name, tool?.kind)) {
        const sig = callSignature(call)
        if (!discoveryCalls.has(sig)) {
          discoveryCalls.add(sig)
          discoveryIterations.add(iter)
        }
      }
      if (opts.onStep) {
        const durationMs = Date.now() - startedAt
        const shown = clipText(clean, SUBAGENT_CAPS.stepOutput)
        const diff = ok && preview?.length ? preview : undefined
        step(
          {
            turn: iter + 1,
            kind: 'tool',
            tool: call.name,
            summary: labelFor(call),
            ok,
            hint: stepHint(call.name, clean, ok, { preview: diff, durationMs }),
            // A nested agent's work shows in its own record, not as raw output here.
            ...(call.name === 'dispatch_agent' ? {} : { output: shown.text }),
            ...(shown.truncated && call.name !== 'dispatch_agent' ? { outputTruncated: true } : {}),
            ...(diff ? { preview: diff } : {}),
            startedAt,
            durationMs
          },
          stepIndex
        )
      }
    }

    // Loop detection, as in the main loop: one corrective nudge, then stop.
    if (stall) {
      const action = stall.observe({ calls, errors: iterErrors })
      if (action.kind === 'nudge') {
        lastStallNudge = iter
        messages.push(systemNoteMessage(action.message))
        notice(iter, 'Repeating itself; told to change approach')
      } else if (action.kind === 'stop') {
        const report = lastText.trim()
        return finish(
          report
            ? `${report}\n\n[subagent stopped: it kept repeating the same step]`
            : '[subagent stopped: it kept repeating the same step without reaching an answer]',
          'stalled'
        )
      }
    }
  }

  // Unreachable in practice (the last step never runs tools), kept as a safe exit.
  return finish(lastText.trim() || '[subagent reached its step limit without a final answer]', 'step-limit')
}
