import { randomUUID } from 'node:crypto'
import { isApprovalPolicy, type AppSettings, type ApprovalPolicy } from '@shared/types'
import { needsLegalAcceptance, LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import type { AgentEvent, AgentRunRequest, ChatMessage, QuestionOption } from '@shared/agent'
import { flagValue, nameOf, resolveHeadlessModel } from './headless'

/**
 * Interactive terminal mode: a stay-resident REPL you converse with directly in
 * the terminal — the third client over the shared agent core, alongside the GUI
 * and the one-shot headless CLI. Unlike headless (fire one prompt and exit), this
 * keeps a conversation going, streams output live, and — crucially — prompts a
 * *real* human for tool approvals and `ask_user` questions instead of
 * auto-answering.
 *
 * The agent loop is UI-agnostic (see headless.ts), so this is again just an
 * alternate entry point + transport: the same provider adapters, tools, sandbox,
 * and rules apply. Everything here is pure / dependency-injected (no Electron, no
 * `node:readline`, no real stdin/stdout) so it can be unit-tested; index.ts wires
 * the real terminal I/O when an interactive flag is present.
 */

export interface TuiOptions {
  cwd: string
  providerId?: string
  model?: string
  /** Starting approval policy; switchable at runtime with `/approval`. Defaults to 'ask'. */
  approvalPolicy: ApprovalPolicy
  /** Accept the legal terms non-interactively (parity with headless `--accept-terms`). */
  acceptTerms: boolean
  /** Colorize output. index.ts sets this from TTY + NO_COLOR detection. */
  color: boolean
}

/**
 * Parse argv for interactive mode. Returns null when no interactive flag
 * (`-i` / `--interactive` / `--tui`) is present, so the caller falls through to
 * the headless check and then the GUI. Shares flag plumbing with headless so the
 * two entry points accept the same `--cwd` / `--provider` / `--model` /
 * `--approval` / `--full-auto` / `--accept-terms` options.
 */
export function parseTuiArgs(argv: string[], defaultCwd: string): TuiOptions | null {
  let interactive = false
  let cwd = defaultCwd
  let providerId: string | undefined
  let model: string | undefined
  let approvalPolicy: ApprovalPolicy = 'ask'
  let acceptTerms = false

  for (let i = 0; i < argv.length; i++) {
    const name = nameOf(argv[i])
    if (name === '-i' || name === '--interactive' || name === '--tui') {
      interactive = true
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
    } else if (name === '--accept-terms') {
      acceptTerms = true
    }
  }

  if (!interactive) return null
  return { cwd, providerId, model, approvalPolicy, acceptTerms, color: true }
}

// --- Rendering ---------------------------------------------------------------
// Small ANSI helpers. Kept as a factory returning plain string transforms so the
// render functions are pure and testable (assert on content, and that color=false
// emits no escape codes), and so a non-TTY / NO_COLOR run is styling-free.

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
} as const

export type Painter = (s: string, ...styles: Array<keyof typeof ANSI>) => string

export function makePainter(color: boolean): Painter {
  if (!color) return (s) => s
  return (s, ...styles) => `${styles.map((k) => ANSI[k]).join('')}${s}${ANSI.reset}`
}

/** One-line summary of a tool starting, e.g. "· read_file  src/x.ts". */
export function renderToolStart(name: string, args: Record<string, unknown>, paint: Painter): string {
  const hint = toolArgHint(args)
  const suffix = hint ? `  ${paint(hint, 'dim')}` : ''
  return `${paint('·', 'dim')} ${paint(name, 'cyan')}${suffix}`
}

/** Best-effort one-liner describing a tool call's most salient argument. */
export function toolArgHint(args: Record<string, unknown>): string {
  for (const key of ['path', 'file', 'file_path', 'command', 'cmd', 'query', 'url', 'pattern']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) return truncate(v.replace(/\s+/g, ' ').trim(), 80)
  }
  return ''
}

/**
 * The approval prompt shown for a `tool_approval` event. The kind + an unconfined
 * shell warning matter for consent, so they're surfaced prominently.
 */
export function renderApprovalPrompt(
  ev: Extract<AgentEvent, { type: 'tool_approval' }>,
  paint: Painter
): string {
  const warn =
    ev.kind === 'shell' && ev.sandboxed === false
      ? `\n${paint('⚠ runs UNSANDBOXED (no OS confinement on this host)', 'yellow', 'bold')}`
      : ''
  const head = paint(`Approve ${ev.name}`, 'bold')
  const kind = paint(`[${ev.kind}]`, 'dim')
  return `\n${head} ${kind}\n  ${ev.summary}${warn}\n${paint('  [y] allow   [n] deny   [a] always allow this kind', 'dim')}`
}

/** Map a freeform approval answer to a decision, defaulting to deny on anything unclear. */
export function parseApprovalAnswer(answer: string): 'allow' | 'deny' | 'always' {
  const a = answer.trim().toLowerCase()
  if (a === 'y' || a === 'yes' || a === 'allow') return 'allow'
  if (a === 'a' || a === 'always') return 'always'
  return 'deny'
}

/** The prompt shown for an `ask_user` question: the question plus numbered options. */
export function renderQuestion(
  question: string,
  options: QuestionOption[],
  multiSelect: boolean,
  paint: Painter
): string {
  const lines = [`\n${paint('? ', 'magenta')}${paint(question, 'bold')}`]
  options.forEach((o, i) => {
    const desc = o.description ? paint(`  — ${o.description}`, 'dim') : ''
    lines.push(`  ${paint(String(i + 1), 'cyan')}. ${o.label}${desc}`)
  })
  const hint = multiSelect
    ? 'Enter numbers (comma-separated) or type an answer'
    : 'Enter a number or type an answer'
  lines.push(paint(`  ${hint}`, 'dim'))
  return lines.join('\n')
}

/**
 * Resolve a freeform answer against the offered options: a number (or
 * comma-separated numbers when multiSelect) maps to option labels; anything else
 * is passed through verbatim so the user can always type a custom reply.
 */
export function resolveQuestionAnswer(
  answer: string,
  options: QuestionOption[],
  multiSelect: boolean
): string {
  const trimmed = answer.trim()
  if (!trimmed) return trimmed
  const parts = multiSelect ? trimmed.split(',').map((p) => p.trim()) : [trimmed]
  const picked: string[] = []
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const opt = options[Number(part) - 1]
      if (opt) {
        picked.push(opt.label)
        continue
      }
    }
    // Any non-index token means the user typed a custom answer — honor it as-is.
    return trimmed
  }
  return picked.length ? picked.join(', ') : trimmed
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// --- Slash commands ----------------------------------------------------------

export type SlashResult =
  | { kind: 'handled' }
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'set-approval'; policy: ApprovalPolicy }
  | { kind: 'set-model'; providerId: string; model: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'not-a-command' }

/**
 * Interpret a line as a slash command. Pure: returns the *intent*; the driver
 * applies side effects (printing, state changes) so this stays testable. Only
 * lines that start with '/' are commands; everything else is prompt text.
 */
export function parseSlashCommand(line: string, settings: AppSettings): SlashResult {
  if (!line.startsWith('/')) return { kind: 'not-a-command' }
  const [name, ...rest] = line.slice(1).trim().split(/\s+/)
  const arg = rest.join(' ')
  switch (name) {
    case 'exit':
    case 'quit':
    case 'q':
      return { kind: 'exit' }
    case 'clear':
    case 'new':
      return { kind: 'clear' }
    case 'approval': {
      if (isApprovalPolicy(arg)) return { kind: 'set-approval', policy: arg }
      return { kind: 'handled' } // no/invalid arg → driver prints current + usage
    }
    case 'model': {
      if (!arg) return { kind: 'handled' } // driver lists providers/models
      const resolved = resolveModelArg(arg, settings)
      if (resolved) return { kind: 'set-model', ...resolved }
      return { kind: 'handled' }
    }
    case 'help':
    case 'cwd':
    case 'model?':
      return { kind: 'handled' }
    default:
      return { kind: 'unknown', name }
  }
}

/**
 * Resolve a `/model` argument into a provider + model. Accepts `providerId`,
 * `providerId/model`, or a bare model id that a configured provider offers.
 */
export function resolveModelArg(
  arg: string,
  settings: AppSettings
): { providerId: string; model: string } | null {
  const slash = arg.indexOf('/')
  if (slash >= 0) {
    const providerId = arg.slice(0, slash)
    const model = arg.slice(slash + 1)
    const p = settings.providers.find((pr) => pr.id === providerId)
    if (p && model) return { providerId, model }
    return null
  }
  const byProvider = settings.providers.find((p) => p.id === arg)
  if (byProvider) {
    const model = byProvider.defaultModel ?? byProvider.models[0]?.id
    if (model) return { providerId: byProvider.id, model }
    return null
  }
  const owner = settings.providers.find((p) => p.models.some((m) => m.id === arg))
  if (owner) return { providerId: owner.id, model: arg }
  return null
}

export const HELP_TEXT = [
  'Commands:',
  '  /help                 show this help',
  '  /model [id]           list models, or switch (providerId, providerId/model, or model)',
  '  /approval [policy]    show or set policy (plan | ask | auto-edit | full-auto)',
  '  /clear, /new          start a fresh conversation',
  '  /cwd                  show the working directory',
  '  /exit, /quit          leave (or press Ctrl-D)',
  '',
  'While a turn runs: Ctrl-C interrupts it. Answer approvals with y / n / a.'
].join('\n')

// --- The interactive driver --------------------------------------------------

/** Abstract terminal I/O, so the driver runs headless in tests. */
export interface TuiIo {
  /** Print to the main output stream (stdout). */
  out: (s: string) => void
  /**
   * Read one line, showing `prompt`. Resolves null on end-of-input (Ctrl-D),
   * which ends the session. Used for the composer, approvals, and questions
   * alike — the driver only ever has one read outstanding at a time.
   */
  readLine: (prompt: string) => Promise<string | null>
  /**
   * Register a handler for an interrupt (Ctrl-C). The driver uses it to cancel
   * the in-flight run without exiting. Optional so tests can drive interrupts
   * directly.
   */
  onInterrupt?: (handler: () => void) => void
  /**
   * Resolve any in-flight `readLine` with null. Called on interrupt so an
   * approval/question prompt awaiting input can't outlive the run it belongs to
   * and hang the loop. No-op when nothing is being read.
   */
  cancelRead?: () => void
}

export interface TuiDeps {
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
  cancelRun: (runId: string) => void
  io: TuiIo
  newId?: () => string
}

/** Prompt string shown for the composer, reflecting the live approval policy. */
export function composerPrompt(policy: ApprovalPolicy, paint: Painter): string {
  return `${paint(policy, 'dim')} ${paint('›', 'green')} `
}

/**
 * Run the interactive session to completion, returning an exit code (0 normal
 * exit, 2 terms declined). Keeps conversation context in memory across turns via
 * the run loop's `onMessages` callback; runs are started without a conversation
 * id (like headless), so nothing is persisted and turns can't collide.
 */
export async function runTui(opts: TuiOptions, deps: TuiDeps): Promise<number> {
  const paint = makePainter(opts.color)
  const settings = deps.getSettings()
  const newId = deps.newId ?? randomUUID

  // Legal gate — interactive, so we can ask right here instead of forcing a flag
  // like headless does. --accept-terms still works for scripted launches.
  if (needsLegalAcceptance(settings.legalAcceptedVersion)) {
    if (!opts.acceptTerms) {
      deps.io.out(
        `\nBefore using Houston you must accept the Terms of Use, Privacy Policy, and License.\n` +
          `  Terms:   ${TERMS_URL}\n  Privacy: ${PRIVACY_URL}\n  License: ${LICENSE_URL}\n`
      )
      const answer = await deps.io.readLine('Accept? [y/N] ')
      if (parseApprovalAnswer(answer ?? '') !== 'allow') {
        deps.io.out('Terms not accepted. Exiting.\n')
        return 2
      }
    }
    deps.recordLegalAcceptance()
    deps.io.out(paint('· Houston terms accepted (recorded for future runs)\n', 'dim'))
  }

  const resolved = resolveHeadlessModel(settings, opts)
  if ('error' in resolved) {
    deps.io.out(`${resolved.error}\n`)
    return 1
  }

  // Mutable session state.
  let providerId = resolved.providerId
  let model = resolved.model
  let policy = opts.approvalPolicy
  let messages: ChatMessage[] = []
  let activeRunId: string | null = null

  deps.io.onInterrupt?.(() => {
    if (activeRunId) {
      deps.cancelRun(activeRunId)
      // Release an approval/question prompt that may be blocking on input, so the
      // aborted run doesn't leave the loop waiting on a read that will never come.
      deps.io.cancelRead?.()
    }
  })

  deps.io.out(
    `${paint('Houston', 'bold', 'cyan')} — interactive\n` +
      `${paint(`  cwd:      ${opts.cwd}`, 'dim')}\n` +
      `${paint(`  model:    ${providerId} / ${model}`, 'dim')}\n` +
      `${paint(`  approval: ${policy}`, 'dim')}\n` +
      `${paint('  /help for commands, Ctrl-D to exit', 'dim')}\n`
  )

  for (;;) {
    const line = await deps.io.readLine(composerPrompt(policy, paint))
    if (line === null) break // Ctrl-D
    const text = line.trim()
    if (!text) continue

    if (text.startsWith('/')) {
      const result = parseSlashCommand(text, deps.getSettings())
      if (result.kind === 'exit') break
      if (result.kind === 'clear') {
        messages = []
        deps.io.out(paint('· conversation cleared\n', 'dim'))
        continue
      }
      if (result.kind === 'set-approval') {
        policy = result.policy
        deps.io.out(paint(`· approval policy → ${policy}\n`, 'dim'))
        continue
      }
      if (result.kind === 'set-model') {
        providerId = result.providerId
        model = result.model
        deps.io.out(paint(`· model → ${providerId} / ${model}\n`, 'dim'))
        continue
      }
      if (result.kind === 'unknown') {
        deps.io.out(paint(`Unknown command: /${result.name}. Try /help.\n`, 'yellow'))
        continue
      }
      // 'handled' — informational commands print here where the state lives.
      handleInfoCommand(text, { providerId, model, policy, cwd: opts.cwd }, deps, paint)
      continue
    }

    messages.push({ role: 'user', content: text })
    const runId = newId()
    activeRunId = runId
    const req: AgentRunRequest = {
      runId,
      workspace: opts.cwd,
      providerId,
      model,
      approvalPolicy: policy,
      messages
    }
    // Serialize interactive prompts (approvals/questions) so two readLine calls
    // never overlap on the single input stream.
    let prompts: Promise<void> = Promise.resolve()
    const enqueue = (task: () => Promise<void>): void => {
      prompts = prompts.then(task).catch(() => {})
    }

    const send = (e: AgentEvent): void => {
      switch (e.type) {
        case 'text':
          deps.io.out(e.delta)
          break
        case 'reasoning':
          deps.io.out(paint(e.delta, 'dim'))
          break
        case 'tool_start':
          deps.io.out(`\n${renderToolStart(e.name, e.args, paint)}\n`)
          break
        case 'tool_result':
          if (!e.ok) deps.io.out(paint(`  ✗ ${e.name} failed\n`, 'red'))
          break
        case 'tool_approval':
          enqueue(async () => {
            deps.io.out(`${renderApprovalPrompt(e, paint)}\n`)
            const ans = await deps.io.readLine('> ')
            deps.resolveApproval(e.runId, e.callId, parseApprovalAnswer(ans ?? ''))
          })
          break
        case 'tool_question':
          enqueue(async () => {
            deps.io.out(`${renderQuestion(e.question, e.options, e.multiSelect ?? false, paint)}\n`)
            const ans = await deps.io.readLine('> ')
            deps.resolveQuestion(
              e.runId,
              e.callId,
              resolveQuestionAnswer(ans ?? '', e.options, e.multiSelect ?? false)
            )
          })
          break
        case 'usage':
          deps.io.out(
            paint(
              `\n· ${e.inputTokens}+${e.outputTokens} tok · $${e.cost.toFixed(4)}\n`,
              'dim'
            )
          )
          break
        case 'error':
          deps.io.out(paint(`\nError: ${e.message}\n`, 'red'))
          break
        case 'limit':
          deps.io.out(paint(`\n· stopped: ${e.reason}\n`, 'yellow'))
          break
        case 'compaction':
          deps.io.out(paint(`\n· compacted ${e.summarized} messages\n`, 'dim'))
          break
        case 'done':
          deps.io.out('\n')
          break
      }
    }

    await deps.startRun(req, send, (m: ChatMessage[]) => {
      messages = m
    })
    // Drain any approval/question prompts still in flight before the next composer read.
    await prompts
    activeRunId = null
  }

  deps.io.out(paint('\nBye.\n', 'dim'))
  return 0
}

function handleInfoCommand(
  line: string,
  state: { providerId: string; model: string; policy: ApprovalPolicy; cwd: string },
  deps: TuiDeps,
  paint: Painter
): void {
  const name = nameOf(line.slice(1).trim().split(/\s+/)[0])
  if (name === 'help') {
    deps.io.out(`${HELP_TEXT}\n`)
    return
  }
  if (name === 'cwd') {
    deps.io.out(`${state.cwd}\n`)
    return
  }
  if (name === 'approval') {
    deps.io.out(
      paint(`approval: ${state.policy}  (plan | ask | auto-edit | full-auto)\n`, 'dim')
    )
    return
  }
  if (name === 'model' || name === 'model?') {
    const settings = deps.getSettings()
    deps.io.out(paint(`current: ${state.providerId} / ${state.model}\n`, 'dim'))
    for (const p of settings.providers) {
      const ready = !p.requiresKey || p.hasKey
      const flag = ready ? '' : paint(' (no key)', 'yellow')
      const models = p.models.map((m) => m.id).join(', ') || paint('none', 'dim')
      deps.io.out(`  ${paint(p.id, 'cyan')}${flag}: ${models}\n`)
    }
  }
}
