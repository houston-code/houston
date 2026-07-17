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
import { needsLegalAcceptance, LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import { missingKeyHint } from '@shared/provider-keys'
import { pickDefaultModel } from '@shared/models'
import { assertNever } from '@shared/assert'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  ElicitationResult,
  PlanDecision,
  ToolApprovalDecision
} from '@shared/agent'

/**
 * One-shot headless mode: run a single prompt through the agent loop without the
 * GUI, streaming output to stdout, and exit with a status code. The agent loop is
 * already UI-agnostic, so this is just an alternate entry point + transport — the
 * same provider adapters, tools, sandbox, and rules apply.
 *
 * Everything here is pure / dependency-injected (no Electron, no real I/O) so it
 * can be unit-tested; index.ts wires the real deps when a prompt flag is present.
 */

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
  let onApproval: HeadlessApprovalMode | undefined
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
    } else if (name === '--on-approval') {
      const { value, next } = flagValue(argv, i)
      // Fail closed: an unrecognized value denies rather than falling back to
      // the policy default, which under --full-auto would silently be 'allow'.
      onApproval = isHeadlessApprovalMode(value) ? value : 'deny'
      i = next
    } else if (name === '--json') {
      json = true
    } else if (name === '--accept-terms') {
      acceptTerms = true
    }
  }

  if (prompt === undefined || prompt === '') return null
  return {
    prompt,
    cwd,
    providerId,
    model,
    approvalPolicy,
    // An explicit --on-approval wins regardless of flag order; otherwise the
    // policy picks: full-auto keeps auto-approving, the gating policies deny.
    onApproval: onApproval ?? (approvalPolicy === 'full-auto' ? 'allow' : 'deny'),
    json,
    acceptTerms,
    continueSession,
    resumeId
  }
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
 * Run one prompt to completion and return an exit code (0 ok, 1 error). In
 * `--json` mode every agent event is emitted as a JSON line; otherwise assistant
 * text streams to stdout and tool activity to stderr. Approval prompts (from the
 * gating policies, and from the always-prompt cases every policy has: network/MCP
 * first use, unconfined or workspace-escaping shell) are resolved per
 * `opts.onApproval` since there's no human to ask — denied by default, approved
 * under full-auto or an explicit `--on-approval allow`.
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
  // verifyOnStop-enabled profile silently gets no verification headless. Surface
  // that once up front rather than letting it look like a broken setting. Only a
  // policy that can actually edit ('auto-edit'/'full-auto') will exercise the gate.
  if (settings.verifyOnStop === true && opts.approvalPolicy === 'plan') {
    deps.err(
      'warning: verifyOnStop is enabled but this headless run is read-only (plan mode); ' +
        'pass --full-auto to run end-of-run verification.\n'
    )
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
      case 'model_fallback':
        if (!opts.json) deps.err(`· ${e.from} unavailable, falling back to ${e.to}… ${e.reason}\n`)
        break
      case 'usage':
        inTok += e.inputTokens
        outTok += e.outputTokens
        cost += e.cost
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
                : '· shell commands will run offline (pass --on-approval allow to permit network)\n'
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
          deps.resolveApproval(e.runId, e.callId, 'allow')
        } else {
          if (!opts.json) {
            deps.err(`· denying ${e.name} (no interactive user; pass --on-approval allow to permit gated calls)\n`)
          }
          if (opts.onApproval === 'fail') failed = true
          deps.resolveApproval(e.runId, e.callId, 'deny')
        }
        break
      case 'tool_question':
        // No interactive user in headless mode — auto-answer so an `ask_user`
        // call can't hang the run forever. The agent gets a clear signal to
        // proceed on its own rather than a silent empty string.
        if (!opts.json) deps.err('· no interactive user (headless): auto-answering ask_user\n')
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
          deps.err('· no interactive reviewer (headless): plan not executed; use --full-auto to make changes\n')
        }
        deps.resolvePlan(e.runId, e.callId, { kind: 'reject' })
        break
      case 'compaction':
        if (!opts.json) deps.err(`· compacted ${e.summarized} messages\n`)
        break
      case 'notice':
        // A user-addressed note (a hook's systemMessage). Meta output, so stderr —
        // stdout stays the model's answer; --json already emitted the raw event.
        if (!opts.json) deps.err(`· ${e.message}\n`)
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

  await deps.startRun(req, send, (m) => {
    if (deps.session && conversationId) deps.session.setMessages(conversationId, m)
  })
  return failed ? 1 : 0
}
