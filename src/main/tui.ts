import { randomUUID } from 'node:crypto'
import { isApprovalPolicy, type AppSettings, type ApprovalPolicy } from '@shared/types'
import { needsLegalAcceptance, LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import type { AgentEvent, AgentRunRequest, ChatMessage, QuestionOption } from '@shared/agent'
import { contextWindowFor, contextPercent } from '@shared/usage'
import { truncateVisible } from './tui-wrap'
import { MarkdownStream } from './markdown-ansi'
import { htmlToAnsi } from './syntax'
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

/**
 * Color themes: each maps a style key to its SGR sequence. `default` is standard
 * ANSI; `bright` uses the high-intensity foregrounds (for dark terminals);
 * `mono` keeps structure (bold/dim) but drops color (light terminals / a11y).
 * The style keys are identical across themes, so every renderer is theme-agnostic.
 */
export const THEMES = {
  default: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
  },
  bright: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m',
    blue: '\x1b[94m', magenta: '\x1b[95m', cyan: '\x1b[96m'
  },
  mono: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '', green: '', yellow: '', blue: '', magenta: '', cyan: ''
  }
} as const

export type ThemeName = keyof typeof THEMES
export type Painter = (s: string, ...styles: Array<keyof (typeof THEMES)['default']>) => string

export function isThemeName(v: string): v is ThemeName {
  return v in THEMES
}

export function makePainter(color: boolean, theme: ThemeName = 'default'): Painter {
  if (!color) return (s) => s
  const palette = THEMES[theme] ?? THEMES.default
  return (s, ...styles) => {
    const codes = styles.map((k) => palette[k]).filter(Boolean).join('')
    return codes ? `${codes}${s}${palette.reset}` : s
  }
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

/**
 * Reconstruct a reviewable diff from a write tool's arguments (captured at
 * `tool_start`), so an edit can be seen before it's approved. Handles the shapes
 * of the built-in write tools: `apply_patch` (a ready patch envelope), `edit_file`
 * (old→new strings), and `write_file` (whole-file content). Returns null when no
 * diff can be derived.
 */
export function extractDiff(args: Record<string, unknown>): string | null {
  const path = typeof args.path === 'string' ? args.path : undefined
  if (typeof args.patch === 'string' && args.patch.trim()) return args.patch
  if (typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    const header = path ? `--- ${path}\n+++ ${path}\n` : ''
    const minus = args.old_string.split('\n').map((l) => `-${l}`).join('\n')
    const plus = args.new_string.split('\n').map((l) => `+${l}`).join('\n')
    return `${header}${minus}\n${plus}`
  }
  if (typeof args.content === 'string') {
    const header = path ? `+++ ${path} (new file)\n` : ''
    return header + args.content.split('\n').map((l) => `+${l}`).join('\n')
  }
  return null
}

/** Colorize a unified diff, capped at `maxLines` so a huge edit doesn't flood the terminal. */
export function colorizeDiff(diff: string, paint: Painter, maxLines = 40): string {
  const lines = diff.split('\n')
  const shown = lines.slice(0, maxLines).map((l) => {
    // Header markers must be checked before +/- since `+++`/`---` also start with them.
    if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('@@')) return paint(l, 'cyan')
    if (l.startsWith('+')) return paint(l, 'green')
    if (l.startsWith('-')) return paint(l, 'red')
    return paint(l, 'dim')
  })
  if (lines.length > maxLines) shown.push(paint(`… ${lines.length - maxLines} more lines`, 'dim'))
  return shown.map((l) => `  ${l}`).join('\n')
}

/** One-line result summary: a failure marker, or a dimmed snippet of the output's first content line. */
export function renderToolResult(name: string, ok: boolean, output: string, paint: Painter): string {
  if (!ok) return paint(`  ✗ ${name} failed`, 'red')
  const firstLine = output.split('\n').find((l) => l.trim()) ?? ''
  const snippet = truncate(firstLine.trim(), 80)
  return snippet ? paint(`  ↳ ${snippet}`, 'dim') : ''
}

/** Running token/cost totals for the session. */
export interface SessionCost {
  inputTokens: number
  outputTokens: number
  cost: number
}

/** Format a cost total, e.g. "1,234+567 tok · $0.0123". */
export function formatSessionCost(c: SessionCost): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  return `${n(c.inputTokens)}+${n(c.outputTokens)} tok · $${c.cost.toFixed(4)}`
}

/** Status marker for a subagent row, printed as a discrete line in line mode. */
export function subagentGlyph(status: 'running' | 'done' | 'error'): string {
  return status === 'done' ? '✓' : status === 'error' ? '✗' : '·'
}

/** Braille spinner frames (Dots animation). */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/**
 * One spinner frame, e.g. `⠋ Thinking 4s`. The terminal adapter prefixes a
 * carriage-return + clear-line and redraws only this single line, so it never
 * scrolls or tears — the one and only in-place redraw in the TUI, kept minimal on
 * purpose to preserve the otherwise append-only (flicker-free) model.
 */
export function spinnerFrame(tick: number, label: string, elapsedSec: number, paint: Painter): string {
  const i = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  return `${paint(SPINNER_FRAMES[i], 'cyan')} ${label} ${paint(`${elapsedSec}s`, 'dim')}`
}

export interface StatusState {
  providerId: string
  model: string
  policy: ApprovalPolicy
  cwd: string
  cost: SessionCost
  /** Current context size in tokens (last turn's input tokens); 0 until a turn runs. */
  contextTokens: number
}

/** Shorten a path for the status line: `~` for home, and only the last two segments. */
export function shortCwd(cwd: string, home = process.env.HOME): string {
  let p = cwd
  if (home && (p === home || p.startsWith(`${home}/`))) p = `~${p.slice(home.length)}`
  const segs = p.split('/').filter(Boolean)
  if (segs.length <= 2) return p
  return `${p.startsWith('~') ? '~/' : '…/'}${segs.slice(-2).join('/')}`
}

/**
 * A one-line status footer shown above the composer: model, approval policy, cwd,
 * session cost, and context-window fill (a green→yellow→red mini bar + percent).
 * Truncated to `width` so it never wraps.
 */
export function renderStatusLine(s: StatusState, width: number, paint: Painter): string {
  const pct = contextPercent(s.contextTokens, contextWindowFor(s.model))
  const parts = [
    paint(`${s.providerId}/${s.model}`, 'cyan'),
    paint(s.policy, 'dim'),
    paint(shortCwd(s.cwd), 'dim'),
    `$${s.cost.cost.toFixed(4)}`
  ]
  if (pct !== null) {
    const tone = pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green'
    parts.push(`${paint(contextBar(pct), tone)} ${paint(`${pct}%`, tone)}`)
  }
  return truncateVisible(parts.join(paint(' · ', 'dim')), Math.max(0, width))
}

/** A tiny 10-cell context-fill bar like `▓▓▓░░░░░░░`. */
function contextBar(pct: number, cells = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  return `${'▓'.repeat(filled)}${'░'.repeat(cells - filled)}`
}

// --- Session persistence -----------------------------------------------------
// The TUI persists each session as an ordinary conversation (via the same store
// the GUI uses), so sessions survive restarts, can be resumed with `/resume`, and
// show up in the GUI's sidebar — one history across both clients.

/** A persisted conversation, minimally described for the resume picker. */
export interface ResumeEntry {
  id: string
  title: string
  updatedAt: number
}

/** Persistence hooks, injected so the driver stays testable without a real store. */
export interface TuiPersist {
  create: (input: { workspace: string; providerId: string; model: string }) => { id: string }
  setMessages: (id: string, messages: ChatMessage[]) => void
  list: (workspace: string) => ResumeEntry[]
  get: (id: string) => { messages: ChatMessage[] } | null
  /** Recent sessions in this folder whose title/content matches `query`. */
  search: (workspace: string, query: string) => ResumeEntry[]
  /** Duplicate a conversation (fresh id, copied history); null if it can't be forked. */
  fork: (id: string) => { id: string } | null
}

/** Render a numbered picker of recent conversations for `/resume`. */
export function renderConversationList(convs: ResumeEntry[], now: number, paint: Painter): string {
  if (!convs.length) return paint('No saved sessions in this folder yet.', 'dim')
  const lines = [paint('Recent sessions:', 'bold')]
  convs.forEach((c, i) => {
    const when = paint(formatRelativeTime(c.updatedAt, now), 'dim')
    lines.push(`  ${paint(String(i + 1), 'cyan')}. ${c.title}  ${when}`)
  })
  lines.push(paint('  Enter a number to resume, or anything else to cancel', 'dim'))
  return lines.join('\n')
}

/** Map a resume selection (1-based index) to a conversation id, or null to cancel. */
export function parseResumeSelection(answer: string, convs: ResumeEntry[]): string | null {
  const n = Number(answer.trim())
  if (Number.isInteger(n) && n >= 1 && n <= convs.length) return convs[n - 1].id
  return null
}

// --- Capability introspection ------------------------------------------------
// Read-only views of what the agent can reach in this workspace — skills, custom
// agents, MCP servers, hooks — so a terminal user can see the capability surface
// before granting approvals, without opening the GUI.

export interface CapabilityItem {
  name: string
  detail?: string
}

export interface CapabilitySnapshot {
  skills: CapabilityItem[]
  agents: CapabilityItem[]
  mcp: CapabilityItem[]
  hooks: CapabilityItem[]
}

/** Render a labelled capability list, or a dim "none" note when empty. */
export function renderCapabilityList(label: string, items: CapabilityItem[], paint: Painter): string {
  if (!items.length) return paint(`No ${label.toLowerCase()} active in this folder.`, 'dim')
  const lines = [paint(`${label}:`, 'bold')]
  for (const it of items) {
    const detail = it.detail ? paint(` — ${truncate(it.detail, 70)}`, 'dim') : ''
    lines.push(`  ${paint(it.name, 'cyan')}${detail}`)
  }
  return lines.join('\n')
}

/** Compact relative time like "just now", "3m ago", "2h ago", "5d ago". */
export function formatRelativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
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
  | { kind: 'resume'; query: string }
  | { kind: 'fork' }
  | { kind: 'capability'; which: 'skills' | 'agents' | 'mcp' | 'hooks' }
  | { kind: 'set-theme'; theme: ThemeName }
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
    case 'resume':
    case 'sessions':
      return { kind: 'resume', query: arg }
    case 'fork':
      return { kind: 'fork' }
    case 'skills':
    case 'agents':
    case 'mcp':
    case 'hooks':
      return { kind: 'capability', which: name }
    case 'theme': {
      if (isThemeName(arg)) return { kind: 'set-theme', theme: arg }
      return { kind: 'handled' } // no/invalid arg → driver lists themes
    }
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
    case 'cost':
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
  '  /resume [query]       list (or search) and reopen a saved session',
  '  /fork                 branch the current session into a copy',
  '  /cost                 show session token + cost totals',
  '  /skills /agents       list workspace skills / custom agents',
  '  /mcp /hooks           list configured MCP servers / hooks',
  '  /theme [name]         list or switch color theme (default | bright | mono)',
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
   *
   * `discardPending` drops any input buffered before the prompt is shown. The
   * driver sets it for security-sensitive reads (approvals, questions) so
   * type-ahead the user entered while output was streaming can't silently answer
   * a prompt they never saw.
   */
  readLine: (prompt: string, opts?: { discardPending?: boolean }) => Promise<string | null>
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
  /**
   * Show a single-line activity spinner with an elapsed timer while a turn runs,
   * so a slow first token or a silent tool doesn't look like a hang. The adapter
   * redraws only that one line and erases it before any real output. All three are
   * optional and no-ops off-TTY / in tests (the driver never depends on them).
   */
  startSpinner?: (label: string) => void
  setSpinnerLabel?: (label: string) => void
  stopSpinner?: () => void
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
  /**
   * Optional persistence. When present, each session is saved as a conversation
   * (resumable with `/resume`, visible in the GUI); when absent, the session is
   * ephemeral — kept only in memory, exactly like a one-shot headless run.
   */
  persist?: TuiPersist
  newId?: () => string
  /** Clock for relative timestamps; injectable for tests. Defaults to Date.now. */
  now?: () => number
  /** Terminal width for the status line + wrapping; injectable. Defaults to 80. */
  columns?: () => number
  /** Persist a submitted composer line to history (for Up/Down across restarts). */
  persistHistory?: (line: string) => void
  /** Snapshot of the workspace's skills / agents / MCP servers / hooks, for /mcp etc. */
  capabilities?: () => Promise<CapabilitySnapshot>
  /**
   * Optional syntax highlighter returning highlight.js token HTML for a fenced
   * code block, or null to render it plain. Kept as HTML (not ANSI) so the hljs
   * dependency stays at the entry point and the driver + its tests need no hljs.
   */
  highlightHtml?: (lang: string, code: string) => string | null
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
  // Reassigned by /theme (takes effect from the next output); the spinner keeps
  // the initial theme since its painter lives in the terminal adapter.
  let paint = makePainter(opts.color)
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
  // The persisted conversation backing this session, created lazily on the first
  // turn (so merely opening and closing the REPL doesn't litter history). Null
  // until then, or after `/clear` starts a fresh one.
  let conversationId: string | null = null
  const sessionCost: SessionCost = { inputTokens: 0, outputTokens: 0, cost: 0 }
  // Estimated current context size (last turn's input tokens), for the status line.
  let contextTokens = 0
  const nowFn = deps.now ?? Date.now
  const columns = deps.columns ?? (() => 80)

  deps.io.onInterrupt?.(() => {
    if (activeRunId) {
      deps.cancelRun(activeRunId)
      deps.io.stopSpinner?.()
      // Show that the interrupt registered — otherwise an aborted turn just stops
      // with no feedback — then release any approval/question prompt blocked on
      // input so the aborted run doesn't leave the loop waiting on a dead read.
      deps.io.out(paint('\n^C interrupted\n', 'dim'))
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
    // A persistent status line above the composer: model, policy, cwd, cost, and
    // context-window fill — so live session state is always visible.
    deps.io.out(
      `${renderStatusLine({ providerId, model, policy, cwd: opts.cwd, cost: sessionCost, contextTokens }, columns(), paint)}\n`
    )
    const line = await deps.io.readLine(composerPrompt(policy, paint))
    if (line === null) break // Ctrl-D
    const text = line.trim()
    if (!text) continue
    // Persist composer submissions (commands included) for cross-restart recall;
    // approval/question answers go through a different read and aren't saved.
    deps.persistHistory?.(text)

    if (text.startsWith('/')) {
      const result = parseSlashCommand(text, deps.getSettings())
      if (result.kind === 'exit') break
      if (result.kind === 'clear') {
        messages = []
        conversationId = null // next turn starts (and persists) a fresh conversation
        deps.io.out(paint('· conversation cleared\n', 'dim'))
        continue
      }
      if (result.kind === 'resume') {
        if (!deps.persist) {
          deps.io.out(paint('· resume is unavailable (no session store)\n', 'dim'))
          continue
        }
        const query = result.query.trim()
        const convs = query ? deps.persist.search(opts.cwd, query) : deps.persist.list(opts.cwd)
        deps.io.out(`${renderConversationList(convs, nowFn(), paint)}\n`)
        if (!convs.length) continue
        const ans = await deps.io.readLine('> ')
        const id = ans === null ? null : parseResumeSelection(ans, convs)
        if (!id) {
          deps.io.out(paint('· cancelled\n', 'dim'))
          continue
        }
        const conv = deps.persist.get(id)
        if (!conv) {
          deps.io.out(paint('· that session could not be loaded\n', 'dim'))
          continue
        }
        conversationId = id
        messages = conv.messages
        deps.io.out(paint(`· resumed — ${messages.length} message(s)\n`, 'dim'))
        continue
      }
      if (result.kind === 'fork') {
        if (!deps.persist || !conversationId) {
          deps.io.out(paint('· nothing to fork yet — start a conversation first\n', 'dim'))
          continue
        }
        const forked = deps.persist.fork(conversationId)
        if (!forked) {
          deps.io.out(paint('· could not fork this session\n', 'dim'))
          continue
        }
        conversationId = forked.id
        deps.io.out(paint('· forked — continuing on a copy, original left intact\n', 'dim'))
        continue
      }
      if (result.kind === 'capability') {
        if (!deps.capabilities) {
          deps.io.out(paint('· capability info is unavailable\n', 'dim'))
          continue
        }
        const snap = await deps.capabilities()
        const labels = { skills: 'Skills', agents: 'Agents', mcp: 'MCP servers', hooks: 'Hooks' }
        deps.io.out(`${renderCapabilityList(labels[result.which], snap[result.which], paint)}\n`)
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
      if (result.kind === 'set-theme') {
        paint = makePainter(opts.color, result.theme)
        deps.io.out(paint(`· theme → ${result.theme}\n`, 'dim'))
        continue
      }
      if (result.kind === 'unknown') {
        deps.io.out(paint(`Unknown command: /${result.name}. Try /help.\n`, 'yellow'))
        continue
      }
      // 'handled' — informational commands print here where the state lives.
      handleInfoCommand(text, { providerId, model, policy, cwd: opts.cwd, sessionCost }, deps, paint)
      continue
    }

    messages.push({ role: 'user', content: text })
    // Lazily open a persisted conversation on the first turn so the session
    // survives restarts and is resumable. Ephemeral when no store is injected.
    if (deps.persist && !conversationId) {
      conversationId = deps.persist.create({ workspace: opts.cwd, providerId, model }).id
    }
    const runId = newId()
    activeRunId = runId
    const req: AgentRunRequest = {
      runId,
      ...(conversationId ? { conversationId } : {}),
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
    // Args captured at tool_start, so a write approval can show the actual diff
    // (the approval event itself only carries a human summary).
    const toolArgs = new Map<string, Record<string, unknown>>()
    // Assistant text streams through a markdown renderer that emits whole blocks
    // as they finalize. Any non-text event flushes the pending block first, so
    // text always renders before the tool line / prompt that follows it.
    const highlight = deps.highlightHtml
      ? (lang: string, code: string): string => {
          const html = deps.highlightHtml?.(lang, code)
          return html ? htmlToAnsi(html, paint) : code
        }
      : undefined
    const md = new MarkdownStream({ paint, width: columns(), highlight })
    const flushMd = (): void => {
      const s = md.flush()
      if (s) deps.io.out(s)
    }
    // Liveness while the agent works (relabelled per event; erased on any output).
    deps.io.startSpinner?.('Working')

    const send = (e: AgentEvent): void => {
      if (e.type === 'text') {
        deps.io.out(md.push(e.delta))
        return
      }
      flushMd()
      switch (e.type) {
        case 'reasoning':
          deps.io.setSpinnerLabel?.('Thinking')
          deps.io.out(paint(e.delta, 'dim'))
          break
        case 'tool_start':
          deps.io.setSpinnerLabel?.(e.name)
          toolArgs.set(e.callId, e.args)
          deps.io.out(`\n${renderToolStart(e.name, e.args, paint)}\n`)
          break
        case 'tool_result': {
          const line = renderToolResult(e.name, e.ok, e.output, paint)
          if (line) deps.io.out(`${line}\n`)
          toolArgs.delete(e.callId)
          break
        }
        case 'tool_progress':
          if (e.message.trim()) deps.io.out(paint(`  … ${truncate(e.message.trim(), 80)}\n`, 'dim'))
          break
        case 'subagent':
          // Line mode can't update a row in place, so print discrete markers: a
          // start line, then a done/error line, indented under the parent tool.
          deps.io.out(paint(`    ${subagentGlyph(e.status)} ${e.label}\n`, 'dim'))
          break
        case 'retry':
          deps.io.setSpinnerLabel?.('Retrying')
          deps.io.out(paint(`\n· retrying (${e.attempt}/${e.max})… ${e.message}\n`, 'yellow'))
          break
        case 'tool_approval':
          enqueue(async () => {
            deps.io.out(`${renderApprovalPrompt(e, paint)}\n`)
            // For a write, show the diff being approved when we can reconstruct it.
            if (e.kind === 'write') {
              const diff = extractDiff(toolArgs.get(e.callId) ?? {})
              if (diff) deps.io.out(`${colorizeDiff(diff, paint)}\n`)
            }
            const ans = await deps.io.readLine('> ', { discardPending: true })
            deps.resolveApproval(e.runId, e.callId, parseApprovalAnswer(ans ?? ''))
          })
          break
        case 'tool_question':
          enqueue(async () => {
            deps.io.out(`${renderQuestion(e.question, e.options, e.multiSelect ?? false, paint)}\n`)
            const ans = await deps.io.readLine('> ', { discardPending: true })
            deps.resolveQuestion(
              e.runId,
              e.callId,
              resolveQuestionAnswer(ans ?? '', e.options, e.multiSelect ?? false)
            )
          })
          break
        case 'usage':
          sessionCost.inputTokens += e.inputTokens
          sessionCost.outputTokens += e.outputTokens
          sessionCost.cost += e.cost
          // Current context size ≈ the tokens sent this turn; feeds the status line.
          contextTokens = e.inputTokens
          deps.io.out(
            paint(
              `\n· ${e.inputTokens}+${e.outputTokens} tok · $${e.cost.toFixed(4)}` +
                `  (session ${formatSessionCost(sessionCost)})\n`,
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
      // Mirror the GUI: persist the running message log so the session is durable
      // and resumable even if it's interrupted mid-turn.
      if (deps.persist && conversationId) deps.persist.setMessages(conversationId, m)
    })
    deps.io.stopSpinner?.()
    // Drain any approval/question prompts still in flight before the next composer read.
    await prompts
    activeRunId = null
  }

  deps.io.out(paint('\nBye.\n', 'dim'))
  return 0
}

function handleInfoCommand(
  line: string,
  state: {
    providerId: string
    model: string
    policy: ApprovalPolicy
    cwd: string
    sessionCost: SessionCost
  },
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
  if (name === 'cost') {
    deps.io.out(paint(`session: ${formatSessionCost(state.sessionCost)}\n`, 'dim'))
    return
  }
  if (name === 'theme') {
    deps.io.out(paint(`themes: ${Object.keys(THEMES).join(', ')}  (usage: /theme <name>)\n`, 'dim'))
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
