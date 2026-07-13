import { randomUUID } from 'node:crypto'
import { isApprovalPolicy, type AppSettings, type ApprovalPolicy, type ProviderConfig } from '@shared/types'
import { needsLegalAcceptance, LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import { missingKeyHint } from '@shared/provider-keys'
import { assertNever } from '@shared/assert'
import type { AgentEvent, AgentRunRequest, ChatMessage, PlanDecision } from '@shared/agent'

/**
 * One-shot headless mode: run a single prompt through the agent loop without the
 * GUI, streaming output to stdout, and exit with a status code. The agent loop is
 * already UI-agnostic, so this is just an alternate entry point + transport — the
 * same provider adapters, tools, sandbox, and rules apply.
 *
 * Everything here is pure / dependency-injected (no Electron, no real I/O) so it
 * can be unit-tested; index.ts wires the real deps when a prompt flag is present.
 */

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
  json: boolean
  /** `--continue`: resume the most recent session in this folder (script → take over). */
  continueSession: boolean
  /** `--resume <id>`: resume a specific saved session (e.g. one started in the TUI). */
  resumeId?: string
  /**
   * Accept the legal terms (Terms of Use, Privacy Policy, License) for this and
   * future runs. Required the first time headless mode is used on a profile that
   * hasn't accepted them (the GUI shows a gate; headless has no UI, so it's a
   * flag). Once accepted it's persisted, so later runs don't need it.
   */
  acceptTerms: boolean
}

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
 * path Electron injects, etc.) are ignored.
 */
export function parseHeadlessArgs(argv: string[], defaultCwd: string): HeadlessOptions | null {
  let prompt: string | undefined
  let cwd = defaultCwd
  let providerId: string | undefined
  let model: string | undefined
  let approvalPolicy: ApprovalPolicy = 'plan'
  let json = false
  let acceptTerms = false
  let continueSession = false
  let resumeId: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const name = nameOf(argv[i])
    if (name === '-p' || name === '--prompt') {
      const { value, next } = flagValue(argv, i)
      prompt = value
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
    } else if (name === '--json') {
      json = true
    } else if (name === '--accept-terms') {
      acceptTerms = true
    }
  }

  if (prompt === undefined || prompt === '') return null
  return { prompt, cwd, providerId, model, approvalPolicy, json, acceptTerms, continueSession, resumeId }
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
  const pick = (p: { id: string; defaultModel?: string; models: { id: string }[] }): string =>
    opts.model ?? p.defaultModel ?? p.models[0]?.id ?? ''
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

/**
 * The stderr message shown when a headless run is blocked on legal acceptance.
 * `isUpdate` is true when the user accepted an earlier terms version and is being
 * asked to re-accept after a change (vs. a fresh first run). Exported for tests.
 */
export function legalAcceptanceMessage(isUpdate: boolean): string {
  const lead = isUpdate
    ? 'Houston’s Terms of Use, Privacy Policy, and License have been updated and must be re-accepted before using headless mode.\n'
    : 'You must accept the Houston Terms of Use, Privacy Policy, and License before using headless mode.\n'
  return (
    lead +
    `  Terms:   ${TERMS_URL}\n` +
    `  Privacy: ${PRIVACY_URL}\n` +
    `  License: ${LICENSE_URL}\n` +
    'Re-run with --accept-terms to accept (recorded once; later runs won’t ask).\n'
  )
}

export interface HeadlessDeps {
  getSettings: () => AppSettings
  /** Persist acceptance of the current legal terms (sets legalAcceptedVersion). */
  recordLegalAcceptance: () => void
  startRun: (
    req: AgentRunRequest,
    send: (e: AgentEvent) => void,
    onMessages?: (messages: ChatMessage[]) => void
  ) => Promise<void>
  resolveApproval: (runId: string, callId: string, decision: 'allow' | 'deny' | 'always') => void
  resolveQuestion: (runId: string, callId: string, answer: string) => void
  resolvePlan: (runId: string, callId: string, decision: PlanDecision) => void
  out: (s: string) => void
  err: (s: string) => void
  newId?: () => string
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
  }
}

/**
 * Run one prompt to completion and return an exit code (0 ok, 1 error). In
 * `--json` mode every agent event is emitted as a JSON line; otherwise assistant
 * text streams to stdout and tool activity to stderr. Approval prompts (only
 * possible under ask/auto-edit) are auto-approved since there's no human — the
 * default 'plan' policy is read-only and never prompts.
 */
export async function runHeadless(opts: HeadlessOptions, deps: HeadlessDeps): Promise<number> {
  const settings = deps.getSettings()

  // Legal gate: the GUI shows a blocking acceptance dialog on first run; headless
  // has no UI, so it requires --accept-terms once. Acceptance is then persisted,
  // so later runs (and the GUI) don't ask again. Exit code 2 distinguishes
  // "terms not accepted" from a normal run failure (1). A non-zero stored version
  // means the terms changed since they last accepted (vs. a fresh first run).
  if (needsLegalAcceptance(settings.legalAcceptedVersion)) {
    if (!opts.acceptTerms) {
      deps.err(legalAcceptanceMessage((settings.legalAcceptedVersion ?? 0) > 0))
      return 2
    }
    deps.recordLegalAcceptance()
    if (!opts.json) deps.err('· Houston terms accepted (recorded for future runs)\n')
  }

  const resolved = resolveHeadlessModel(settings, opts)
  if ('error' in resolved) {
    deps.err(`${resolved.error}\n`)
    return 1
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
      deps.err('· no prior session to resume — starting a fresh one\n')
    }
    if (prior) {
      conversationId = prior.id
      messages.push(...prior.messages)
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
  // verifyOnStop-enabled profile silently gets no verification headless. Surface
  // that once up front rather than letting it look like a broken setting. Only a
  // policy that can actually edit ('auto-edit'/'full-auto') will exercise the gate.
  if (settings.verifyOnStop === true && opts.approvalPolicy === 'plan') {
    deps.err(
      'warning: verifyOnStop is enabled but this headless run is read-only (plan mode); ' +
        'pass --full-auto to run end-of-run verification.\n'
    )
  }

  const runId = (deps.newId ?? randomUUID)()
  const req: AgentRunRequest = {
    runId,
    ...(conversationId ? { conversationId } : {}),
    workspace: opts.cwd,
    providerId: resolved.providerId,
    model: resolved.model,
    approvalPolicy: opts.approvalPolicy,
    messages
  }

  let failed = false
  // Accumulate token/cost so text mode can print a one-line total on completion
  // (JSON mode carries the raw `usage` events instead).
  let inTok = 0
  let outTok = 0
  let cost = 0
  const send = (e: AgentEvent): void => {
    if (opts.json) {
      deps.out(`${JSON.stringify(e)}\n`)
    }
    switch (e.type) {
      case 'text':
        if (!opts.json) deps.out(e.delta)
        break
      case 'tool_start':
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
      case 'usage':
        inTok += e.inputTokens
        outTok += e.outputTokens
        cost += e.cost
        break
      case 'tool_approval':
        if (!opts.json) deps.err(`· auto-approving ${e.name}\n`)
        deps.resolveApproval(e.runId, e.callId, 'allow')
        break
      case 'tool_question':
        // No interactive user in headless mode — auto-answer so an `ask_user`
        // call can't hang the run forever. The agent gets a clear signal to
        // proceed on its own rather than a silent empty string.
        if (!opts.json) deps.err('· no interactive user (headless) — auto-answering ask_user\n')
        deps.resolveQuestion(
          e.runId,
          e.callId,
          '[No interactive user is available in headless mode. Proceed using your best judgment.]'
        )
        break
      case 'limit':
        // The loop ended by hitting a budget/guard rather than a natural stop.
        // Surface every reason so a script can see WHY the run stopped short; a
        // 'stalled' termination is a soft failure (the agent gave up looping), so
        // it flips the exit code, while max-steps/max-output stay code 0 (the run
        // did as much as its budget allowed — not an error).
        if (!opts.json) {
          const why =
            e.reason === 'stalled'
              ? 'stopped: the agent stalled (no forward progress)'
              : e.reason === 'max-output'
                ? 'stopped: the model hit its output limit'
                : 'stopped: reached the maximum number of steps'
          deps.err(`· ${why}\n`)
        }
        if (e.reason === 'stalled') failed = true
        break
      case 'verification':
        // The end-of-run verification command ran; report pass/fail. A failing
        // pass is fed back for self-correction inside the loop (it doesn't end the
        // run here), so this is informational — the final exit code follows 'done'.
        if (!opts.json)
          deps.err(`· verification ${e.passed ? 'passed' : 'failed'}\n`)
        break
      case 'error':
        failed = true
        deps.err(`Error: ${e.message}\n`)
        break
      case 'done':
        if (!opts.json) {
          deps.out('\n')
          if (inTok || outTok || cost) deps.err(`· ${inTok}+${outTok} tok · $${cost.toFixed(4)}\n`)
        }
        if (e.stopReason === 'error' || e.stopReason === 'aborted') failed = true
        break
      case 'plan_ready':
        // No interactive reviewer in headless. Print the plan (the deliverable of a
        // plan-mode run) and reject so present_plan unblocks without editing anything,
        // matching the read-only intent of the default policy. Re-run with --full-auto
        // (which isn't Plan mode, so this is never reached) to actually make changes.
        if (!opts.json) {
          deps.out(`\n${e.plan.title}\n`)
          if (e.plan.body) deps.out(`${e.plan.body}\n`)
          deps.err('· no interactive reviewer (headless) — plan not executed; use --full-auto to make changes\n')
        }
        deps.resolvePlan(e.runId, e.callId, { kind: 'reject' })
        break
      case 'compaction':
        if (!opts.json) deps.err(`· compacted ${e.summarized} messages\n`)
        break
      // Internal/streaming events with no headless surface: the --json path above
      // already emits each verbatim, and the human output doesn't show them.
      case 'reasoning':
      case 'subagent':
      case 'tool_progress':
      case 'turn_start':
        break
      default:
        assertNever(e, 'headless:unhandled agent event')
    }
  }

  await deps.startRun(req, send, (m) => {
    if (deps.session && conversationId) deps.session.setMessages(conversationId, m)
  })
  return failed ? 1 : 0
}
