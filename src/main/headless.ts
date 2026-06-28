import { randomUUID } from 'node:crypto'
import { isApprovalPolicy, type AppSettings, type ApprovalPolicy } from '@shared/types'
import type { AgentEvent, AgentRunRequest } from '@shared/agent'

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
  /** Defaults to 'plan' (read-only) so a headless run can't edit/run unless asked. */
  approvalPolicy: ApprovalPolicy
  json: boolean
}

/** Read a flag's value, supporting both `--flag value` and `--flag=value`. */
function flagValue(argv: string[], i: number): { value?: string; next: number } {
  const arg = argv[i]
  const eq = arg.indexOf('=')
  if (eq >= 0) return { value: arg.slice(eq + 1), next: i }
  const v = argv[i + 1]
  if (v === undefined) return { value: undefined, next: i }
  return { value: v, next: i + 1 }
}

function nameOf(arg: string): string {
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

  for (let i = 0; i < argv.length; i++) {
    const name = nameOf(argv[i])
    if (name === '-p' || name === '--prompt') {
      const { value, next } = flagValue(argv, i)
      prompt = value
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
    }
  }

  if (prompt === undefined || prompt === '') return null
  return { prompt, cwd, providerId, model, approvalPolicy, json }
}

/** Resolve the provider + model to use for a headless run from flags and settings. */
export function resolveHeadlessModel(
  settings: AppSettings,
  opts: Pick<HeadlessOptions, 'providerId' | 'model'>
): { providerId: string; model: string } | { error: string } {
  const pick = (p: { id: string; defaultModel?: string; models: { id: string }[] }): string =>
    opts.model ?? p.defaultModel ?? p.models[0]?.id ?? ''

  if (opts.providerId) {
    const p = settings.providers.find((pr) => pr.id === opts.providerId)
    if (!p) return { error: `Unknown provider: ${opts.providerId}` }
    const model = pick(p)
    if (!model) return { error: `No model for provider "${opts.providerId}". Pass --model.` }
    return { providerId: p.id, model }
  }

  if (settings.selected) {
    return { providerId: settings.selected.providerId, model: opts.model ?? settings.selected.model }
  }

  const ready = settings.providers.find((p) => (!p.requiresKey || p.hasKey) && p.models.length > 0)
  if (ready) return { providerId: ready.id, model: pick(ready) }

  return { error: 'No model configured. Set one in the app, or pass --provider/--model.' }
}

export interface HeadlessDeps {
  getSettings: () => AppSettings
  startRun: (req: AgentRunRequest, send: (e: AgentEvent) => void) => Promise<void>
  resolveApproval: (runId: string, callId: string, decision: 'allow' | 'deny' | 'always') => void
  resolveQuestion: (runId: string, callId: string, answer: string) => void
  out: (s: string) => void
  err: (s: string) => void
  newId?: () => string
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
  const resolved = resolveHeadlessModel(settings, opts)
  if ('error' in resolved) {
    deps.err(`${resolved.error}\n`)
    return 1
  }

  const runId = (deps.newId ?? randomUUID)()
  const req: AgentRunRequest = {
    runId,
    workspace: opts.cwd,
    providerId: resolved.providerId,
    model: resolved.model,
    approvalPolicy: opts.approvalPolicy,
    messages: [{ role: 'user', content: opts.prompt }]
  }

  let failed = false
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
      case 'error':
        failed = true
        deps.err(`Error: ${e.message}\n`)
        break
      case 'done':
        if (!opts.json) deps.out('\n')
        if (e.stopReason === 'error' || e.stopReason === 'aborted') failed = true
        break
    }
  }

  await deps.startRun(req, send)
  return failed ? 1 : 0
}
