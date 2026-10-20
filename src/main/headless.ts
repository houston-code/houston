import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  folderTrustState,
  isApprovalPolicy,
  type AppSettings,
  type ApprovalPolicy,
  type ProviderConfig
} from '@shared/types'
import { loadProjectConfig } from './agent/projectConfig'
import { stripControlChars } from './tui-wrap'
import { missingKeyHint } from '@shared/provider-keys'
import { runtimeMissingLine } from '@shared/runtimes'
import { formatReceiptLines, type TurnReceipt } from '@shared/evidence'
import { formatReadinessLines } from '@shared/planReadiness'
import { pickDefaultModel } from '@shared/models'
import { assertNever } from '@shared/assert'
import { createFindingPrinter } from '@shared/reviewFindings'
import {
  isReasoningEffort,
  REASONING_EFFORTS,
  type AgentEvent,
  type AgentRunRequest,
  type ChatMessage,
  type ElicitationResult,
  type PlanDecision,
  type ReasoningEffort,
  type RunSettingsOverrides,
  type StopReason,
  type ToolApprovalDecision
} from '@shared/agent'

/**
 * One-shot headless mode: run a single prompt through the agent loop without the
 * GUI, writing the reply to stdout as each model round completes, and exit with a
 * status code. The agent loop is already UI-agnostic, so this is just an alternate
 * entry point + transport — the same provider adapters, tools, sandbox, and rules
 * apply.
 *
 * Everything here is pure / dependency-injected (no Electron, no real I/O) so it
 * can be unit-tested; index.ts wires the real deps when a prompt flag is present.
 */

/**
 * The process exit codes of a headless run, so a script or benchmark harness can
 * tell a finished task from one that ran out of budget without parsing output.
 * Documented for users in the README and docs/houston-guide.md; keep them in sync.
 */
export const HEADLESS_EXIT = {
  /** The agent finished on its own. */
  ok: 0,
  /** An error or aborted run, a stalled agent, or a call refused under `--on-approval fail`. */
  failed: 1,
  /** A bad flag value, or no prompt (an empty stdin). Nothing ran. */
  usage: 2,
  /** The run hit a budget (its step cap or the model's output limit) before finishing. */
  limit: 3
} as const

/** How a headless run ended: the `status` of the `--json` result line. */
export type HeadlessStatus = 'success' | 'limit' | 'stalled' | 'approval_denied' | 'error'

/**
 * The last line a `--json` run prints: one summary a harness can read instead of
 * folding the event stream itself.
 */
export interface HeadlessResult {
  type: 'result'
  status: HeadlessStatus
  /** The final `done` event's stop reason; null when the run never got that far. */
  stopReason: StopReason | null
  /** Why the loop stopped short, when a `limit` event ended it. */
  limitReason?: 'max-steps' | 'max-output' | 'stalled'
  /** Model rounds the agent took (the unit `--max-turns` caps). */
  turns: number
  /** Estimated cost in USD, subagent and review rounds included. */
  costUsd: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  /** The assistant text streamed after the run's last tool call: its closing answer. */
  finalText: string
  /**
   * What Houston recorded running this turn (the commands that test, build, install,
   * or serve, with their real exit codes, and the files changed), when there was any.
   * The loop builds it, not the model, so a harness can check `finalText` against it.
   */
  receipt?: TurnReceipt
}

/**
 * What headless does when the loop asks for a tool approval (there is no human
 * to answer). Approval prompts fire under 'ask'/'auto-edit' for their gated
 * kinds, and under EVERY policy for the always-prompt cases: network/MCP first
 * use, unconfined shell, and workspace-escaping shell.
 * - allow: approve the call (the pre-flag behavior, and full-auto's default)
 * - deny:  refuse the call; the agent sees the denial and continues within
 *          what the policy auto-approves
 * - fail:  refuse the call AND exit non-zero, so a script can tell the run hit
 *          a permission wall it wasn't granted
 */
export const HEADLESS_APPROVAL_MODES = ['allow', 'deny', 'fail'] as const

export type HeadlessApprovalMode = (typeof HEADLESS_APPROVAL_MODES)[number]

/** Runtime guard: true when `v` is a known `--on-approval` mode. */
export function isHeadlessApprovalMode(v: unknown): v is HeadlessApprovalMode {
  return typeof v === 'string' && (HEADLESS_APPROVAL_MODES as readonly string[]).includes(v)
}

export interface HeadlessOptions {
  prompt: string
  cwd: string
  providerId?: string
  model?: string
  /**
   * Defaults to 'plan' (read-only) so a headless run can't edit/run unless asked.
   * Note: the `verifyOnStop` verification gate only runs after an edit, so it needs
   * `--full-auto` (or `--approval auto-edit`) headless — under plan mode it never fires.
   */
  approvalPolicy: ApprovalPolicy
  /**
   * `--on-approval`: how to resolve approval prompts (see HEADLESS_APPROVAL_MODES).
   * Defaults per policy: 'allow' under full-auto (that policy already opted into
   * everything, and unsandboxed CI hosts prompt for every shell command), 'deny'
   * otherwise — a policy chosen to gate actions keeps gating them unattended
   * instead of being silently rubber-stamped into full-auto.
   */
  onApproval: HeadlessApprovalMode
  /**
   * `--allow-shell-network`: let shell commands reach the network this run. Interactively
   * that takes a conscious "Allow for run" (or, under full-auto, the one-time network
   * consent), because the shell sandbox can read the whole filesystem. Headless has no
   * prompt to pick it from, and `--on-approval allow` approves each call the way plain
   * "Allow" does, which runs shell offline. So the grant is its own explicit flag rather
   * than a side effect of approving calls. Under full-auto, `--on-approval allow` still
   * answers the network consent too.
   */
  allowShellNetwork: boolean
  json: boolean
  /** `--continue`: resume the most recent session in this folder (script → take over). */
  continueSession: boolean
  /** `--resume <id>`: resume a specific saved session (e.g. one started in the TUI). */
  resumeId?: string
  /**
   * Read the prompt from stdin (`-p -`, or a piped stdin with no prompt given);
   * `prompt` is empty until runHeadless reads it.
   */
  promptFromStdin?: boolean
  /** `--effort`: the reasoning effort for this run, over settings.reasoningEffort. */
  effort?: ReasoningEffort
  /** `--max-turns`: a hard step cap for this run, over settings.maxIterations. */
  maxTurns?: number
  /** `--max-cost`: the USD cost at which the agent is told to wrap up (costCeilingUsd). */
  maxCostUsd?: number
  /** `--verify`: run this command at a natural stop after edits (verifyOnStop + verifyCommand). */
  verifyCommand?: string
  /**
   * A flag carried a value it can't take. runHeadless reports it and exits with
   * HEADLESS_EXIT.usage before anything runs, rather than silently running with
   * a budget or check the caller didn't ask for.
   */
  usageError?: string
}

/** Facts about the process's stdin that decide whether a prompt can come from it. */
export interface HeadlessStdin {
  /** stdin is a pipe or a redirected file, not a terminal or /dev/null. */
  stdinPiped?: boolean
  /**
   * Take a piped stdin as the prompt even with no `-p` at all. The standalone CLI
   * sets it (a bare `houston` in a pipe has no other use); the desktop binary
   * doesn't, since a bare launch there opens the window.
   */
  bareStdinPrompt?: boolean
}

/**
 * Every flag the headless parser reads. `-p` followed by one of these takes no
 * value from it, so `-p --json` with a piped prompt doesn't run "--json" as the task.
 */
const HEADLESS_FLAGS = new Set([
  '-p',
  '--prompt',
  '--continue',
  '--resume',
  '-C',
  '--cwd',
  '--model',
  '--provider',
  '--approval',
  '--full-auto',
  '--on-approval',
  '--allow-shell-network',
  '--json',
  '--effort',
  '--max-turns',
  '--max-cost',
  '--verify'
])

/** Read a flag's value, supporting both `--flag value` and `--flag=value`. */
export function flagValue(argv: string[], i: number): { value?: string; next: number } {
  const arg = argv[i]
  const eq = arg.indexOf('=')
  if (eq >= 0) return { value: arg.slice(eq + 1), next: i }
  const v = argv[i + 1]
  if (v === undefined) return { value: undefined, next: i }
  return { value: v, next: i + 1 }
}

export function nameOf(arg: string): string {
  const eq = arg.indexOf('=')
  return eq >= 0 ? arg.slice(0, eq) : arg
}

/**
 * Parse argv for headless mode. Returns null when no prompt flag is present, so
 * the caller launches the normal GUI. Unknown tokens (the binary path, the app
 * path Electron injects, etc.) are ignored. The prompt comes from stdin for
 * `-p -`, and for a `-p` with no value (or, with `bareStdinPrompt`, no `-p` at
 * all) when stdin is piped.
 */
export function parseHeadlessArgs(
  argv: string[],
  defaultCwd: string,
  stdin: HeadlessStdin = {}
): HeadlessOptions | null {
  let prompt: string | undefined
  let promptFlag = false
  let cwd = defaultCwd
  let providerId: string | undefined
  let model: string | undefined
  let approvalPolicy: ApprovalPolicy = 'plan'
  let onApproval: HeadlessApprovalMode | undefined
  let allowShellNetwork = false
  let json = false
  let continueSession = false
  let resumeId: string | undefined
  let effort: ReasoningEffort | undefined
  let maxTurns: number | undefined
  let maxCostUsd: number | undefined
  let verifyCommand: string | undefined
  let usageError: string | undefined
  // Keep the first bad value: it's the one the caller reads about.
  const bad = (message: string): void => {
    usageError ??= message
  }

  for (let i = 0; i < argv.length; i++) {
    const name = nameOf(argv[i])
    if (name === '-p' || name === '--prompt') {
      promptFlag = true
      if (!argv[i].includes('=') && argv[i + 1] !== undefined && HEADLESS_FLAGS.has(nameOf(argv[i + 1]))) {
        prompt = undefined
        continue
      }
      const { value, next } = flagValue(argv, i)
      prompt = value
      i = next
    } else if (name === '--effort') {
      const { value, next } = flagValue(argv, i)
      if (isReasoningEffort(value)) effort = value
      else bad(`--effort must be one of ${REASONING_EFFORTS.join(', ')} (got ${quoted(value)})`)
      i = next
    } else if (name === '--max-turns') {
      const { value, next } = flagValue(argv, i)
      const n = value !== undefined && /^[0-9]+$/.test(value) ? Number(value) : NaN
      if (Number.isSafeInteger(n) && n >= 1) maxTurns = n
      else bad(`--max-turns must be a whole number of at least 1 (got ${quoted(value)})`)
      i = next
    } else if (name === '--max-cost') {
      const { value, next } = flagValue(argv, i)
      const usd = value !== undefined && value.trim() !== '' ? Number(value) : NaN
      if (Number.isFinite(usd) && usd > 0) maxCostUsd = usd
      else bad(`--max-cost must be a positive amount in US dollars, like 2 or 0.5 (got ${quoted(value)})`)
      i = next
    } else if (name === '--verify') {
      const { value, next } = flagValue(argv, i)
      if (value !== undefined && value.trim() !== '') verifyCommand = value
      else bad('--verify needs a command to run, like --verify "npm test"')
      i = next
    } else if (name === '--continue') {
      continueSession = true
    } else if (name === '--resume') {
      const { value, next } = flagValue(argv, i)
      resumeId = value
      i = next
    } else if (name === '-C' || name === '--cwd') {
      const { value, next } = flagValue(argv, i)
      if (value) cwd = value
      i = next
    } else if (name === '--model') {
      const { value, next } = flagValue(argv, i)
      model = value
      i = next
    } else if (name === '--provider') {
      const { value, next } = flagValue(argv, i)
      providerId = value
      i = next
    } else if (name === '--approval') {
      const { value, next } = flagValue(argv, i)
      if (isApprovalPolicy(value)) approvalPolicy = value
      i = next
    } else if (name === '--full-auto') {
      approvalPolicy = 'full-auto'
    } else if (name === '--on-approval') {
      const { value, next } = flagValue(argv, i)
      // Fail closed: an unrecognized value denies rather than falling back to
      // the policy default, which under --full-auto would silently be 'allow'.
      onApproval = isHeadlessApprovalMode(value) ? value : 'deny'
      i = next
    } else if (name === '--allow-shell-network') {
      // A bare switch. A value form is a usage error rather than ignored or read as a
      // grant, so `--allow-shell-network=false` can't turn network on, and a script
      // that wrote `=true` learns that it didn't.
      if (argv[i].includes('=')) bad('--allow-shell-network takes no value; pass it on its own')
      else allowShellNetwork = true
    } else if (name === '--json') {
      json = true
    }
  }

  // `-p -` always reads stdin; a missing prompt does when stdin was piped in.
  const promptFromStdin =
    prompt === '-' ||
    ((prompt === undefined || prompt === '') &&
      stdin.stdinPiped === true &&
      (promptFlag || stdin.bareStdinPrompt === true))
  if (!promptFromStdin && (prompt === undefined || prompt === '')) return null
  return {
    prompt: promptFromStdin ? '' : (prompt as string),
    cwd,
    providerId,
    model,
    approvalPolicy,
    // An explicit --on-approval wins regardless of flag order; otherwise the
    // policy picks: full-auto keeps auto-approving, the gating policies deny.
    onApproval: onApproval ?? (approvalPolicy === 'full-auto' ? 'allow' : 'deny'),
    allowShellNetwork,
    json,
    continueSession,
    resumeId,
    ...(promptFromStdin ? { promptFromStdin } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(verifyCommand !== undefined ? { verifyCommand } : {}),
    ...(usageError !== undefined ? { usageError } : {})
  }
}

/** A flag value as it appears in an error message. */
function quoted(value: string | undefined): string {
  return value === undefined ? 'nothing' : JSON.stringify(value)
}

/** The run-level setting overrides a headless invocation's flags ask for. */
export function headlessOverrides(opts: HeadlessOptions): RunSettingsOverrides | undefined {
  const o: RunSettingsOverrides = {
    ...(opts.effort !== undefined ? { reasoningEffort: opts.effort } : {}),
    ...(opts.maxTurns !== undefined ? { maxIterations: opts.maxTurns } : {}),
    ...(opts.maxCostUsd !== undefined ? { costCeilingUsd: opts.maxCostUsd } : {}),
    ...(opts.verifyCommand !== undefined ? { verifyCommand: opts.verifyCommand } : {})
  }
  return Object.keys(o).length ? o : undefined
}

/**
 * The provider+model to run, or an error. `recoverable` marks the errors that an
 * interactive session can fix by setting up a provider (a missing key, or nothing
 * configured yet) — the TUI opens its `/login` wizard for those instead of exiting.
 * An explicit bad flag (unknown `--provider`, a provider with no model) is NOT
 * recoverable: it's a usage error to report, not a setup step.
 */
export type ResolvedModel =
  | { providerId: string; model: string }
  | { error: string; recoverable: boolean }

/** Resolve the provider + model to use for a headless run from flags and settings. */
export function resolveHeadlessModel(
  settings: AppSettings,
  opts: Pick<HeadlessOptions, 'providerId' | 'model'>
): ResolvedModel {
  const pick = (p: ProviderConfig): string => opts.model ?? pickDefaultModel(p) ?? ''
  // Preflight: a provider that needs a key but has none would otherwise start the
  // run and fail deep in the provider adapter with a raw error (e.g. `invalid
  // x-api-key`). Surface an actionable message up front instead. The auto-select
  // path below already skips keyless providers, so this only guards the two paths
  // where the provider is chosen explicitly (--provider or a saved selection).
  const keyError = (p: ProviderConfig | undefined): string | null =>
    p && p.requiresKey && !p.hasKey ? missingKeyHint(p.id) : null

  if (opts.providerId) {
    const p = settings.providers.find((pr) => pr.id === opts.providerId)
    if (!p) return { error: `Unknown provider: ${opts.providerId}`, recoverable: false }
    const model = pick(p)
    if (!model) return { error: `No model for provider "${opts.providerId}". Pass --model.`, recoverable: false }
    const noKey = keyError(p)
    if (noKey) return { error: noKey, recoverable: true }
    return { providerId: p.id, model }
  }

  if (settings.selected) {
    const p = settings.providers.find((pr) => pr.id === settings.selected!.providerId)
    const noKey = keyError(p)
    if (noKey) return { error: noKey, recoverable: true }
    return { providerId: settings.selected.providerId, model: opts.model ?? settings.selected.model }
  }

  const ready = settings.providers.find((p) => (!p.requiresKey || p.hasKey) && p.models.length > 0)
  if (ready) return { providerId: ready.id, model: pick(ready) }

  // Host-neutral: this path is shared by the desktop app's headless mode and the
  // standalone CLI, so it can't point at "the app". Both honor --provider/--model,
  // and both need a provider with a usable API key first. Recoverable: the TUI can
  // open /login here; headless just prints it.
  return {
    error:
      'No model configured. Pass --provider and --model, or set up a provider with an API key first.',
    recoverable: true
  }
}

export interface HeadlessDeps {
  getSettings: () => AppSettings
  startRun: (
    req: AgentRunRequest,
    send: (e: AgentEvent) => void,
    onMessages?: (messages: ChatMessage[]) => void
  ) => Promise<void>
  resolveApproval: (
    runId: string,
    callId: string,
    decision: ToolApprovalDecision,
    note?: string
  ) => void
  resolveQuestion: (runId: string, callId: string, answer: string) => void
  resolvePlan: (runId: string, callId: string, decision: PlanDecision) => void
  resolveElicitation: (runId: string, elicitId: string, result: ElicitationResult) => void
  out: (s: string) => void
  err: (s: string) => void
  newId?: () => string
  /** Read all of stdin, for a prompt passed as `-p -` or piped in. */
  readStdin?: () => Promise<string>
  /** Milliseconds clock for the result's `durationMs`; injected so tests are exact. */
  now?: () => number
  /**
   * Session persistence (shared with the TUI/GUI). When present, a headless run is
   * saved as a conversation — so `--continue`/`--resume` can pick it up later and
   * an interactive `-i` session can take over where a script left off. Absent →
   * the run is ephemeral, exactly as before.
   */
  session?: {
    /** Load the target conversation: by `id`, else the most recent for `workspace`. */
    load: (opts: { workspace: string; id?: string }) => { id: string; messages: ChatMessage[] } | null
    create: (input: { workspace: string; providerId: string; model: string }) => { id: string }
    setMessages: (id: string, messages: ChatMessage[]) => void
    /**
     * Rewrite a conversation's stored provider+model. Only needed when resuming a
     * prior session under a different model than it was created with, so its stored
     * meta (and the model a GUI re-open lands on) tracks what actually ran. The
     * fresh-create path already stores the right model via `create`.
     */
    setModel: (id: string, providerId: string, model: string) => void
  }
}

/**
 * Run one prompt to completion and return an exit code (see HEADLESS_EXIT). In
 * `--json` mode every agent event is emitted as a JSON line, then one final
 * `result` line (see HeadlessResult); otherwise assistant text streams to stdout
 * and tool activity to stderr. Approval prompts (from the gating policies, and
 * from the always-prompt cases every policy has: network/MCP first use,
 * unconfined or workspace-escaping shell) are resolved per `opts.onApproval`
 * since there's no human to ask — denied by default, approved under full-auto or
 * an explicit `--on-approval allow`.
 */
export async function runHeadless(inputOpts: HeadlessOptions, deps: HeadlessDeps): Promise<number> {
  // A bad flag value stops here, before any model call, so a typo in a budget
  // can't run with no budget at all.
  if (inputOpts.usageError) {
    deps.err(`${inputOpts.usageError}\n`)
    return HEADLESS_EXIT.usage
  }

  let opts = inputOpts
  if (opts.promptFromStdin) {
    const text = deps.readStdin ? (await deps.readStdin()).trim() : ''
    if (!text) {
      deps.err('No prompt: stdin was empty. Pass -p "<prompt>", or pipe the prompt in.\n')
      return HEADLESS_EXIT.usage
    }
    opts = { ...opts, prompt: text }
  }

  const now = deps.now ?? Date.now
  const settings = deps.getSettings()

  // The `--json` summary line. Written for every run past flag validation, a
  // failed preflight included, so a harness can always read the last line.
  const writeResult = (r: Omit<HeadlessResult, 'type'>): void => {
    if (opts.json) deps.out(`${JSON.stringify({ type: 'result', ...r } satisfies HeadlessResult)}\n`)
  }

  const resolved = resolveHeadlessModel(settings, opts)
  if ('error' in resolved) {
    deps.err(`${resolved.error}\n`)
    writeResult({
      status: 'error',
      stopReason: null,
      turns: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      finalText: ''
    })
    return HEADLESS_EXIT.failed
  }

  // Session continuity: with --continue / --resume, seed the prior conversation's
  // messages so the run picks up where a previous run (or a TUI session) left off;
  // otherwise start a fresh conversation. Persisted (when a store is wired) so the
  // next --continue — or an interactive `-i` /resume — can take over from here.
  let conversationId: string | undefined
  const messages: ChatMessage[] = []
  if (deps.session) {
    const wantsPrior = opts.continueSession || opts.resumeId !== undefined
    const prior = wantsPrior ? deps.session.load({ workspace: opts.cwd, id: opts.resumeId }) : null
    if (wantsPrior && !prior) {
      deps.err('· no prior session to resume; starting a fresh one\n')
    }
    if (prior) {
      conversationId = prior.id
      messages.push(...prior.messages)
      // The conversation stored its provider+model at create time, but this run
      // executes under the resolved --provider/--model (or settings.selected),
      // which can differ from what the resumed session was created with. Rewrite
      // the stored meta so usage attribution and a later GUI re-open track the
      // model that actually ran. Best-effort: a store failure must not crash the
      // run (the create path needs no such rewrite — `create` stored it already).
      try {
        deps.session.setModel(prior.id, resolved.providerId, resolved.model)
      } catch {
        // ignore — persistence is best-effort
      }
    } else {
      conversationId = deps.session.create({
        workspace: opts.cwd,
        providerId: resolved.providerId,
        model: resolved.model
      }).id
    }
  }
  messages.push({ role: 'user', content: opts.prompt })

  // Surface the conversation id so a script can capture it and later `--resume`
  // this exact session — the only place it's observable (‑‑continue is
  // recency-based, and no agent event carries the persistent id). JSON mode gets
  // a typed line on stdout; text mode a stderr marker, keeping stdout clean.
  if (conversationId) {
    if (opts.json) deps.out(`${JSON.stringify({ type: 'session', conversationId })}\n`)
    else deps.err(`· session ${conversationId}\n`)
  }

  // Verify-gate warning: the end-of-run verification command only runs after the
  // model modifies files, which a read-only ('plan') run never does — so a
  // verifyOnStop-enabled profile (or a --verify flag) silently gets no verification
  // headless. Surface that once up front rather than letting it look like a broken
  // setting. Only a policy that can actually edit ('auto-edit'/'full-auto') will
  // exercise the gate.
  if (opts.approvalPolicy === 'plan') {
    if (opts.verifyCommand !== undefined) {
      deps.err(
        'warning: --verify has no effect in a read-only (plan mode) run; ' +
          'pass --full-auto so the agent can edit and the check can run.\n'
      )
    } else if (settings.verifyOnStop === true) {
      deps.err(
        'warning: verifyOnStop is enabled but this headless run is read-only (plan mode); ' +
          'pass --full-auto to run end-of-run verification.\n'
      )
    }
  }

  // Trusted folders: a headless run never prompts, so an undecided (or drifted)
  // folder's elevating project config (allow rules / hooks / MCP servers) is
  // simply left off — the loop enforces that; this just says so once. Trust the
  // folder from the desktop app or an interactive `houston -i` session.
  try {
    const projectCfg = await loadProjectConfig(opts.cwd)
    if (projectCfg.elevatedHash) {
      let path = opts.cwd
      try {
        path = realpathSync(opts.cwd)
      } catch {
        // keep the raw path — the loop normalizes identically
      }
      const state = folderTrustState(settings.trustedFolders, path, projectCfg.elevatedHash)
      if (state !== 'trusted' && !opts.json) {
        deps.err(
          "· ignoring this project's allow rules / hooks / MCP servers (folder not trusted; decide in the desktop app or houston -i)\n"
        )
      }
    }
  } catch {
    // Advisory only — never block a headless run on the trust note.
  }

  const runId = (deps.newId ?? randomUUID)()
  const overrides = headlessOverrides(opts)
  const req: AgentRunRequest = {
    runId,
    ...(conversationId ? { conversationId } : {}),
    workspace: opts.cwd,
    providerId: resolved.providerId,
    model: resolved.model,
    approvalPolicy: opts.approvalPolicy,
    messages,
    // No one can answer ask_user here, so the loop doesn't offer it.
    unattended: true,
    ...(opts.allowShellNetwork ? { allowShellNetwork: true } : {}),
    ...(overrides ? { overrides } : {})
  }
  // Plan mode runs no shell, so the grant would be moot there.
  if (opts.allowShellNetwork && opts.approvalPolicy !== 'plan' && !opts.json) {
    deps.err('· shell commands may reach the network this run (--allow-shell-network)\n')
  }

  // How the run ended, for the exit code and the --json result line.
  let errored = false
  let approvalDenied = false
  let limitReason: HeadlessResult['limitReason']
  let stopReason: StopReason | null = null
  // Say once that approved shell commands run offline, the first time a prompt says so.
  let notedOffline = false
  // Accumulate token/cost so text mode can print a one-line total on completion
  // (JSON mode carries the raw `usage` events, then the totals on the result line).
  let inTok = 0
  let outTok = 0
  let cost = 0
  let turns = 0
  // The closing answer: text streamed since the last tool call. Tool activity (or a
  // verification pass that sends the agent back to work) means the text so far was
  // narration, so it clears the buffer.
  let finalText = ''
  let receipt: TurnReceipt | undefined
  // Review findings print once per status change (see createFindingPrinter).
  const printFinding = createFindingPrinter()
  // Text mode holds each model round's text until the round ends. stdout is the
  // answer a script captures, and bytes written there can't be taken back, so a round
  // that drops mid-stream and is redone (`turn_discarded`) would otherwise leave its
  // partial copy ahead of the full one. While a round streams only its text and
  // reasoning arrive, so any other event means the round is over and its text stays.
  let roundText = ''
  const releaseRound = (): void => {
    if (roundText) deps.out(roundText)
    roundText = ''
  }
  const send = (e: AgentEvent): void => {
    if (opts.json) {
      deps.out(`${JSON.stringify(e)}\n`)
    } else if (e.type === 'turn_discarded') {
      roundText = ''
    } else if (e.type !== 'text' && e.type !== 'reasoning') {
      releaseRound()
    }
    switch (e.type) {
      case 'text':
        finalText += e.delta
        if (!opts.json) roundText += e.delta
        break
      case 'turn_discarded':
        // The dropped round's text is the tail of the closing answer too (nothing but
        // its own deltas arrived since it began), so the result line loses it as well.
        finalText = finalText.slice(0, Math.max(0, finalText.length - e.textChars))
        // Text mode dropped the round's held text above; --json consumers got the
        // event itself and retract `textChars` from what they accumulated.
        if (!opts.json) deps.err('· discarded a reply cut off mid-stream; redoing it\n')
        break
      case 'tool_start':
        finalText = ''
        if (!opts.json) deps.err(`· ${e.name}\n`)
        break
      case 'tool_result':
        // Surface failures (successes are noise) so a script tailing stderr sees a
        // tool error instead of silence — mirrors the TUI's ✗ marker.
        if (!opts.json && !e.ok) deps.err(`· ${e.name} failed\n`)
        break
      case 'retry':
        if (!opts.json) deps.err(`· retrying (${e.attempt}/${e.max})… ${e.message}\n`)
        break
      case 'model_fallback':
        if (!opts.json) deps.err(`· ${e.from} unavailable, falling back to ${e.to}… ${e.reason}\n`)
        break
      case 'usage':
        inTok += e.inputTokens
        outTok += e.outputTokens
        cost += e.cost
        // One usage event per model round of the agent itself. A subagent's or a
        // review's rounds arrive rolled up as one event with inputTokens 0 (kept off
        // the context meter), so they add cost but not turns.
        if (e.inputTokens > 0) turns++
        break
      case 'tool_approval':
        // The full-auto shell-network consent gates only the sandbox's network, not the
        // command (it runs either way), so it's not a permission wall — resolve it per
        // --on-approval without ever flipping the failure flag. 'allow' lets shell reach
        // the network this run; otherwise shell runs offline.
        if (e.shellNetwork) {
          const grant = opts.onApproval === 'allow'
          if (!opts.json) {
            deps.err(
              grant
                ? '· allowing shell network access for this run\n'
                : '· shell commands will run offline (pass --allow-shell-network to permit network)\n'
            )
          }
          deps.resolveApproval(e.runId, e.callId, grant ? 'allow' : 'deny')
          break
        }
        // No human to answer the prompt: resolve per --on-approval. 'allow'
        // approves the call; 'deny'/'fail' refuse it, so the policy's gates hold
        // in unattended runs instead of being rubber-stamped ('fail' also flips
        // the exit code so a script can tell the run hit a permission wall).
        if (opts.onApproval === 'allow') {
          if (!opts.json) deps.err(`· auto-approving ${e.name}\n`)
          // 'allow' is plain "Allow", which runs shell offline until the run has the
          // shell-network grant, and only --allow-shell-network gives that here.
          if (e.shellOffline && !notedOffline && !opts.json) {
            notedOffline = true
            deps.err('· shell commands run without network (pass --allow-shell-network to permit it)\n')
          }
          deps.resolveApproval(e.runId, e.callId, 'allow')
        } else {
          if (!opts.json) {
            deps.err(`· denying ${e.name} (no interactive user; pass --on-approval allow to permit gated calls)\n`)
          }
          if (opts.onApproval === 'fail') approvalDenied = true
          deps.resolveApproval(e.runId, e.callId, 'deny')
        }
        break
      case 'tool_question':
        // A headless run is unattended, so the loop doesn't offer `ask_user` at all.
        // This is the backstop for a model that calls it anyway: auto-answer so the
        // call can't hang the run forever, with a clear signal to proceed on its own
        // rather than a silent empty string.
        if (!opts.json) deps.err('· no interactive user (headless): auto-answering ask_user\n')
        deps.resolveQuestion(
          e.runId,
          e.callId,
          '[No interactive user is available in headless mode. Proceed using your best judgment.]'
        )
        break
      case 'limit':
        // The loop ended by hitting a budget/guard rather than a natural stop.
        // Surface every reason so a script can see WHY the run stopped short. A
        // 'stalled' termination is a failure (the agent gave up looping); a budget
        // stop (max-steps/max-output) gets its own exit code, so a harness can tell
        // "ran out of room" from both a finished task and a crash.
        limitReason = e.reason
        if (!opts.json) {
          const why =
            e.reason === 'stalled'
              ? 'stopped: the agent stalled (no forward progress)'
              : e.reason === 'max-output'
                ? 'stopped: the model hit its output limit'
                : 'stopped: reached the maximum number of steps'
          deps.err(`· ${why}\n`)
        }
        break
      case 'receipt':
        receipt = e.receipt
        // Meta output like a notice: stderr, so stdout stays the model's answer. The
        // labels are model-written commands, so control characters are kept off the terminal.
        if (!opts.json) {
          for (const line of formatReceiptLines(e.receipt)) deps.err(`· ${stripControlChars(line)}\n`)
        }
        break
      case 'verification':
        // The end-of-run verification command ran; report pass/fail. A failing
        // pass is fed back for self-correction inside the loop (it doesn't end the
        // run here), so this is informational — the final exit code follows 'done'.
        // A failure sends the agent back to work, so the answer before it is no
        // longer its last word; a pass follows the final answer and keeps it.
        if (!e.passed) finalText = ''
        if (!opts.json)
          deps.err(`· verification ${e.passed ? 'passed' : 'failed'}\n`)
        break
      case 'error':
        errored = true
        deps.err(`Error: ${e.message}\n`)
        break
      case 'done':
        if (!opts.json) {
          deps.out('\n')
          if (inTok || outTok || cost) deps.err(`· ${inTok}+${outTok} tok · $${cost.toFixed(4)}\n`)
        }
        stopReason = e.stopReason
        if (e.stopReason === 'error' || e.stopReason === 'aborted') errored = true
        break
      case 'plan_ready':
        // No interactive reviewer in headless. Print the plan (the deliverable of a
        // plan-mode run) and reject so present_plan unblocks without editing anything,
        // matching the read-only intent of the default policy. Re-run with --full-auto
        // (which isn't Plan mode, so this is never reached) to actually make changes.
        if (!opts.json) {
          deps.out(`\n${e.plan.title}\n`)
          if (e.plan.body) deps.out(`${e.plan.body}\n`)
          if (e.plan.readiness) {
            for (const line of formatReadinessLines(e.plan.readiness)) deps.err(`· ${stripControlChars(line)}\n`)
          }
          deps.err('· no interactive reviewer (headless): plan not executed; use --full-auto to make changes\n')
        }
        deps.resolvePlan(e.runId, e.callId, { kind: 'reject' })
        break
      case 'compaction':
        if (!opts.json) deps.err(`· compacted ${e.summarized} messages\n`)
        break
      case 'notice':
        // A user-addressed note (a hook's systemMessage, a budget extension). Meta output, so stderr —
        // stdout stays the model's answer; --json already emitted the raw event.
        if (!opts.json) deps.err(`· ${e.message}\n`)
        break
      case 'runtime_missing':
        // Meta output like a notice: stderr, so stdout stays the model's answer.
        if (!opts.json) deps.err(`${runtimeMissingLine(e)}\n`)
        break
      case 'tool_progress':
        // Live progress from a long-running tool (a 16-turn subagent dispatch, a
        // multi-dimension review) — without it the run reads as a stall between
        // tool_start and its result. stderr, like the other tool activity.
        if (!opts.json && e.message.trim()) deps.err(`·   ${e.message.trim()}\n`)
        break
      case 'subagent':
        // A nested subagent row (e.g. one review dimension) starting/finishing.
        if (!opts.json) deps.err(`·   ${e.status === 'running' ? '▷' : e.status === 'done' ? '✓' : '✗'} ${e.label}\n`)
        break
      case 'review_finding': {
        // A review finding as it's raised, then its verdict. stderr, like the rows above.
        const line = opts.json ? null : printFinding(e.parentCallId, e.finding)
        if (line) deps.err(`·     ${line}\n`)
        break
      }
      case 'elicitation':
        // No interactive user in headless mode — decline, so the MCP server takes
        // its documented no-answer path instead of hanging the run. Deliberately
        // NOT governed by --on-approval: that flag approves Houston's own tool
        // calls; auto-accepting would send fabricated field values to an external
        // server as if the user typed them.
        if (!opts.json) {
          deps.err(`· declining input request from MCP server "${e.serverId}" (no interactive user in headless mode)\n`)
        }
        deps.resolveElicitation(e.runId, e.elicitId, { action: 'decline' })
        break
      // Internal/streaming events with no headless surface: the --json path above
      // already emits each verbatim, and the human output doesn't show them.
      // `steered` is here for the same reason — headless has no one at the keyboard
      // to steer a turn, so it can only arrive on a run adopted from elsewhere.
      case 'reasoning':
      case 'turn_start':
      case 'steered':
        break
      default:
        assertNever(e, 'headless:unhandled agent event')
    }
  }

  const startedAt = now()
  await deps.startRun(req, send, (m) => {
    if (deps.session && conversationId) deps.session.setMessages(conversationId, m)
  })
  // A run always ends on `done` or `error`, which releases the last round; this only
  // guarantees held text can't be lost if one never comes.
  if (!opts.json) releaseRound()

  // A failure outranks a budget stop: a run that also hit an error or a refused
  // approval didn't merely run out of room.
  const status: HeadlessStatus = errored
    ? 'error'
    : approvalDenied
      ? 'approval_denied'
      : limitReason === 'stalled'
        ? 'stalled'
        : limitReason
          ? 'limit'
          : 'success'
  writeResult({
    status,
    stopReason,
    ...(limitReason ? { limitReason } : {}),
    turns,
    // Rounded past a millionth of a cent: the sum of per-round floats carries
    // representation noise (0.024000000000000004) a harness shouldn't have to strip.
    costUsd: Math.round(cost * 1e6) / 1e6,
    inputTokens: inTok,
    outputTokens: outTok,
    durationMs: Math.max(0, now() - startedAt),
    finalText,
    ...(receipt ? { receipt } : {})
  })
  return headlessExitCode(status)
}

/** The process exit code for a run that ended with `status`. */
export function headlessExitCode(status: HeadlessStatus): number {
  switch (status) {
    case 'success':
      return HEADLESS_EXIT.ok
    case 'limit':
      return HEADLESS_EXIT.limit
    case 'stalled':
    case 'approval_denied':
    case 'error':
      return HEADLESS_EXIT.failed
    default:
      return assertNever(status, 'headless:unhandled status')
  }
}
