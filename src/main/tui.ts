import { randomUUID } from 'node:crypto'
import {
  isApprovalPolicy,
  type AppSettings,
  type ApprovalPolicy,
  type Hook,
  type McpServerConfig,
  type ProviderConfig
} from '@shared/types'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  customEndpointError,
  customEndpointToProvider,
  customProviderId,
  type CatalogEntry
} from '@shared/provider-catalog'
import { providerKeyUrl } from '@shared/provider-keys'
import {
  BUILTIN_TEMPLATE_COMMANDS,
  expandTemplate,
  mergeCommands,
  resolveCommand,
  type Command
} from '@shared/commands'
import type { CompactResult } from './agent/compact'
import { needsLegalAcceptance, LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  PlanAcceptMode,
  PlanDecision,
  PlanPayload,
  QuestionOption
} from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import { contextWindowFor, contextPercent } from '@shared/usage'
import { assertNever } from '@shared/assert'
import { truncateVisible } from './tui-wrap'
import { MarkdownStream } from './markdown-ansi'
import { htmlToAnsi } from './syntax'
import type { PickerSpec, PickerOutcome } from './tui-picker'
import { ComposerBuffer } from './tui-composer'
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
 *
 * `defaultInteractive` lets a caller treat the absence of `-i` as interactive
 * anyway (still honoring the other flags): the standalone CLI passes it when a
 * bare `houston` is typed at a TTY, so `houston` alone drops into the REPL. The
 * desktop binary leaves it false so a bare `Houston` still opens the GUI.
 */
export function parseTuiArgs(
  argv: string[],
  defaultCwd: string,
  defaultInteractive = false
): TuiOptions | null {
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

  if (!interactive && !defaultInteractive) return null
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

/** The status line shown before any provider is set up: no model, just the /login nudge. */
export function renderNoModelStatus(policy: ApprovalPolicy, cwd: string, paint: Painter): string {
  return [
    paint('no model (run /login)', 'yellow'),
    paint(policy, 'dim'),
    paint(shortCwd(cwd), 'dim')
  ].join(paint(' · ', 'dim'))
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
    const detail = it.detail ? paint(` (${truncate(it.detail, 70)})`, 'dim') : ''
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
    const desc = o.description ? paint(`  (${o.description})`, 'dim') : ''
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

// --- Plan review (present_plan) -----------------------------------------------
// The terminal counterpart to the GUI's docked plan-review panel: render the plan
// the agent presented, collect the same PlanDecision (accept / suggest / reject,
// with an "edit in your editor" variant of accept), and hand it back so the
// blocking present_plan tool call unblocks. Without this the TUI would drop the
// plan_ready event and the run would hang on the pending decision.

/** A decision action offered on a presented plan. */
export type PlanAction = 'accept' | 'accept-ask' | 'edit' | 'suggest' | 'reject'

/** The plan-review actions, in display order, with their single-key shortcuts. */
export const PLAN_ACTIONS: { key: string; action: PlanAction; label: string; description: string }[] = [
  { key: 'a', action: 'accept', label: 'Accept & run', description: 'apply edits automatically' },
  { key: 'k', action: 'accept-ask', label: 'Accept, ask per edit', description: 'approve each change' },
  { key: 'e', action: 'edit', label: 'Edit the plan, then run', description: 'open it in your editor' },
  { key: 's', action: 'suggest', label: 'Suggest changes', description: 'send a note; keep planning' },
  { key: 'r', action: 'reject', label: 'Reject', description: 'discard; keep planning' }
]

/** Render a presented plan (title, body, affected files) plus the decision menu. */
export function renderPlan(plan: PlanPayload, paint: Painter): string {
  const lines = [`\n${paint('▣ Plan:', 'magenta')} ${paint(plan.title, 'bold')}`]
  const body = plan.body?.trim()
  if (body) {
    lines.push('', body)
  } else {
    if (plan.overview) lines.push('', plan.overview)
    for (const step of plan.steps ?? []) lines.push(`  • ${step}`)
  }
  if (plan.files?.length) lines.push('', paint(`Files: ${plan.files.join(', ')}`, 'dim'))
  lines.push('')
  for (const a of PLAN_ACTIONS) {
    lines.push(`  ${paint(`[${a.key}]`, 'cyan')} ${a.label}  ${paint(`(${a.description})`, 'dim')}`)
  }
  return lines.join('\n')
}

/** Map a typed answer to a plan action; defaults to reject (the safe verdict). */
export function parsePlanAction(answer: string): PlanAction {
  const a = answer.trim().toLowerCase()
  const match = PLAN_ACTIONS.find((x) => x.key === a || x.action === a)
  if (match) return match.action
  if (a === 'y' || a === 'yes') return 'accept'
  return 'reject'
}

/** The legacy structured plan as markdown, for the editor when there's no `body`. */
function planToMarkdown(plan: PlanPayload): string {
  if (plan.body) return plan.body
  const parts = [`# ${plan.title}`]
  if (plan.overview) parts.push(plan.overview)
  if (plan.steps?.length) parts.push(plan.steps.map((s) => `- ${s}`).join('\n'))
  return parts.join('\n\n')
}

/** Turn a chosen action into a PlanDecision, collecting an editor edit / note as needed. */
export async function planDecisionFor(
  action: PlanAction,
  plan: PlanPayload,
  deps: TuiDeps,
  paint: Painter
): Promise<PlanDecision> {
  const accept = (mode: PlanAcceptMode): PlanDecision => ({ kind: 'accept', mode })
  switch (action) {
    case 'accept':
      return accept('auto-edit')
    case 'accept-ask':
      return accept('ask')
    case 'edit': {
      const edited = deps.editText ? await deps.editText(planToMarkdown(plan)) : null
      if (edited && edited.trim()) return { kind: 'accept', mode: 'auto-edit', editedBody: edited }
      deps.io.out(paint('· no editor available (set $EDITOR) — accepting the plan as presented\n', 'dim'))
      return accept('auto-edit')
    }
    case 'suggest': {
      const note = (await deps.io.readLine('Suggest changes: ', { discardPending: true })) ?? ''
      // An empty note is a non-decision; treat it as reject rather than an empty suggest.
      return note.trim() ? { kind: 'suggest', note: note.trim() } : { kind: 'reject' }
    }
    case 'reject':
      return { kind: 'reject' }
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** Media type for an image path by extension, or null if not a supported image. */
export function mediaTypeForImagePath(path: string): string | null {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    default:
      return null
  }
}

// --- Slash commands ----------------------------------------------------------

export type SlashResult =
  | { kind: 'handled' }
  | { kind: 'exit' }
  | { kind: 'clear' }
  | { kind: 'resume'; query: string }
  | { kind: 'fork' }
  | { kind: 'capability'; which: 'skills' | 'agents' }
  | { kind: 'set-theme'; theme: ThemeName }
  | { kind: 'image'; path: string }
  | { kind: 'set-approval'; policy: ApprovalPolicy }
  | { kind: 'set-model'; providerId: string; model: string }
  | { kind: 'compact' }
  /** The settings overview hub (/settings). */
  | { kind: 'settings' }
  /** Edit lifecycle hooks (/hooks [add|remove <n>]). */
  | { kind: 'hooks'; action: SettingsAction }
  /** Edit MCP servers (/mcp [add|remove <n>]) — stdio only in the terminal. */
  | { kind: 'mcp'; action: SettingsAction }
  /** Set or replace a provider API key, or add a host (/login, /providers). */
  | { kind: 'login' }
  /** A template command (custom `.houston/commands` or first-party `/review`): run the expanded prompt as a turn. */
  | { kind: 'prompt'; text: string }
  | { kind: 'unknown'; name: string }
  | { kind: 'not-a-command' }

/**
 * Interpret a line as a slash command. Pure: returns the *intent*; the driver
 * applies side effects (printing, state changes) so this stays testable. Only
 * lines that start with '/' are commands; everything else is prompt text.
 */
export function parseSlashCommand(
  line: string,
  settings: AppSettings,
  commands: Command[] = []
): SlashResult {
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
      return { kind: 'capability', which: name }
    case 'settings':
      return { kind: 'settings' }
    case 'hooks':
      return { kind: 'hooks', action: parseSettingsAction(arg) }
    case 'mcp':
      return { kind: 'mcp', action: parseSettingsAction(arg) }
    case 'login':
    case 'providers':
      return { kind: 'login' }
    case 'theme': {
      if (isThemeName(arg)) return { kind: 'set-theme', theme: arg }
      return { kind: 'handled' } // no/invalid arg → driver lists themes
    }
    case 'image':
      return arg ? { kind: 'image', path: arg } : { kind: 'handled' }
    case 'approval': {
      if (isApprovalPolicy(arg)) return { kind: 'set-approval', policy: arg }
      return { kind: 'handled' } // no/invalid arg → driver prints current + usage
    }
    case 'plan':
      // Shortcut for the read-only research-and-propose policy (parity with the GUI's /plan).
      return { kind: 'set-approval', policy: 'plan' }
    case 'compact':
      return { kind: 'compact' }
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
    default: {
      // Not a built-in: try the template commands (first-party like /review, plus
      // custom `.houston/commands`). A match runs its expanded prompt as a turn.
      const cmd = resolveCommand(commands, name)
      if (cmd?.template) return { kind: 'prompt', text: expandTemplate(cmd.template, arg) }
      return { kind: 'unknown', name }
    }
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
  '  /login                set or replace a provider API key, or add a host',
  '  /approval [policy]    show or set policy (plan | ask | auto-edit | full-auto)',
  '  /plan                 shortcut: switch to plan mode (read-only research & propose)',
  '  /clear, /new          start a fresh conversation',
  '  /compact              summarize older turns to free up context now',
  '  /review               adversarial review of your uncommitted changes',
  '  /resume [query]       list (or search) and reopen a saved session',
  '  /fork                 branch the current session into a copy',
  '  /cost                 show session token + cost totals',
  '  /skills /agents       list workspace skills / custom agents',
  '  /settings             settings overview + where to edit them',
  '  /hooks [add|remove n] list or edit lifecycle hooks',
  '  /mcp [add|remove n]   list or edit MCP servers (terminal adds stdio only)',
  '  /theme [name]         list or switch color theme (default | bright | mono)',
  '  /image <path>         attach an image to your next message',
  '  /cwd                  show the working directory',
  '  /<name>               run a custom command from .houston/commands',
  '  /exit, /quit          leave (or press Ctrl-D)',
  '',
  'While a turn runs: Ctrl-C interrupts it. Answer approvals with y / n / a.'
].join('\n')

// --- Settings editing (/settings, /hooks, /mcp) ------------------------------
// A small, safe subset of settings editing for the terminal. The desktop app has
// the full panel; here we cover lifecycle hooks and *local* (stdio) MCP servers.
// We deliberately never touch auth: remote/URL MCP and header secrets are the
// desktop app's job (the CLI can't persist header secrets — see store.ts), so the
// terminal add flow builds header-free stdio configs only.

/** Lifecycle events a hook can bind to (mirrors the Hook.event union in types.ts). */
export const HOOK_EVENTS: Hook['event'][] = [
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Stop',
  'PreCompact'
]

/** What the user asked /hooks or /mcp to do. `remove` carries a 1-based index. */
export type SettingsAction =
  | { op: 'list' }
  | { op: 'add' }
  | { op: 'remove'; index: number }
  | { op: 'usage' }

/** Parse the argument of /hooks or /mcp into an action. Bare command → list. */
export function parseSettingsAction(arg: string): SettingsAction {
  const [verb, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (!verb) return { op: 'list' }
  if (verb === 'add') return { op: 'add' }
  if (verb === 'remove' || verb === 'rm' || verb === 'delete') {
    const n = Number.parseInt(rest[0] ?? '', 10)
    if (Number.isInteger(n) && n >= 1) return { op: 'remove', index: n }
    return { op: 'usage' }
  }
  return { op: 'usage' }
}

/** Map a hook-event answer (a 1-based number or a name) to a candidate event string. */
export function resolveHookEventInput(input: string): string {
  const n = Number.parseInt(input.trim(), 10)
  if (Number.isInteger(n) && n >= 1 && n <= HOOK_EVENTS.length) return HOOK_EVENTS[n - 1]
  return input.trim()
}

/** Validate raw field input into a Hook, or return an error to show the user. */
export function buildHook(event: string, matcher: string, command: string): Hook | { error: string } {
  if (!(HOOK_EVENTS as string[]).includes(event)) {
    return { error: `unknown event "${event}" (expected one of: ${HOOK_EVENTS.join(', ')})` }
  }
  const cmd = command.trim()
  if (!cmd) return { error: 'a hook needs a shell command to run' }
  // Lifecycle events have no tool to match; a blank matcher means "any".
  return { event: event as Hook['event'], matcher: matcher.trim() || '*', command: cmd }
}

/**
 * Validate raw field input into a *stdio* MCP server config, or return an error.
 * No url/headers/env by construction: remote transports and header secrets are the
 * desktop app's domain, so a terminal-added server is always a local process.
 */
export function buildStdioMcpServer(
  existingIds: string[],
  name: string,
  command: string,
  argsStr: string
): McpServerConfig | { error: string } {
  const id = name.trim()
  if (!/^[\w-]+$/.test(id)) {
    return { error: 'name must be letters, numbers, hyphens or underscores (no spaces)' }
  }
  if (existingIds.includes(id)) return { error: `an MCP server named "${id}" already exists` }
  const cmd = command.trim()
  if (!cmd) return { error: 'a command to spawn is required (e.g. npx)' }
  const args = argsStr.trim() ? argsStr.trim().split(/\s+/) : undefined
  return { id, name: id, transport: 'stdio', command: cmd, ...(args ? { args } : {}), enabled: true }
}

/** Numbered list of hooks, or a "none" note. */
export function renderHookList(hooks: Hook[], paint: Painter): string {
  if (!hooks.length) return paint('No hooks configured.', 'dim')
  return hooks
    .map(
      (h, i) =>
        `  ${paint(`${i + 1}.`, 'dim')} ${paint(h.event, 'cyan')}  ${h.matcher}  ${paint('→', 'dim')} ${h.command}`
    )
    .join('\n')
}

/**
 * Numbered list of MCP servers. Only the transport summary is shown — never the
 * `headers` map, whose values are secrets (masked on read, but we don't print them
 * at all).
 */
export function renderMcpList(servers: McpServerConfig[], paint: Painter): string {
  if (!servers.length) return paint('No MCP servers configured.', 'dim')
  return servers
    .map((s, i) => {
      const transport = s.transport ?? 'stdio'
      const detail =
        transport === 'stdio'
          ? `${s.command}${s.args?.length ? ` ${s.args.join(' ')}` : ''}`
          : (s.url ?? '')
      const off = s.enabled === false ? paint(' (disabled)', 'dim') : ''
      return `  ${paint(`${i + 1}.`, 'dim')} ${paint(s.name ?? s.id, 'cyan')}${off}  ${paint(`[${transport}]`, 'dim')}  ${detail}`
    })
    .join('\n')
}

/** The "where the file is / changes need a restart" footer shared by the settings commands. */
export function renderSettingsFooter(path: string, paint: Painter): string {
  return paint(`settings file: ${path}\n(changes are picked up on restart)`, 'dim')
}

// --- /login: in-session API-key setup ----------------------------------------
// A guided flow to set a provider's API key — or add a host — without leaving the
// session or hand-editing a credentials file. Auto-launched on a keyless start and
// reachable any time via /login (alias /providers). The pure pieces (menu render +
// choice parsing + custom-endpoint validation) are exported for tests; the async
// driver below reads input and persists through the injected setKey/updateSettings
// seams (writing to safeStorage on the desktop, cli-credentials.json on the CLI).

/** Configured providers that authenticate with an API key — the rows of the /login menu. */
export function keyableProviders(settings: AppSettings): ProviderConfig[] {
  return settings.providers.filter((p) => p.requiresKey)
}

/** How many model ids to preview per provider row before collapsing to "+N more". */
const MENU_MODEL_PREVIEW = 4

/**
 * A compact model summary for one menu row: the first few ids, then a dim `+N more`
 * so a provider with hundreds of models (e.g. an aggregator) doesn't wrap into a wall
 * of text. Empty list renders "no models yet".
 */
export function summarizeModels(ids: string[], paint: Painter, max = MENU_MODEL_PREVIEW): string {
  if (!ids.length) return paint('no models yet', 'dim')
  if (ids.length <= max) return ids.join(', ')
  return `${ids.slice(0, max).join(', ')}${paint(`, +${ids.length - max} more`, 'dim')}`
}

/** Render the provider menu: each keyable provider with its key status, then "Other host…". */
export function renderProviderMenu(
  providers: ProviderConfig[],
  paint: Painter,
  opts: { firstRun: boolean; otherHostExamples?: string }
): string {
  const lines: string[] = [
    opts.firstRun
      ? paint('No model is ready yet. None of your providers has an API key.', 'yellow')
      : paint('Providers (key status on this profile):', 'bold')
  ]
  const otherLabel = 'Other host…'
  // Align the status column to the widest label (built-in names like "Anthropic
  // (Claude)" and custom-endpoint labels vary in length), so the rows don't stagger.
  const labelWidth = Math.max(otherLabel.length, ...providers.map((p) => (p.label ?? p.id).length))
  providers.forEach((p, i) => {
    const status = p.hasKey ? paint('✓ key set', 'green') : paint('✗ no key ', 'dim')
    const models = summarizeModels(
      p.models.map((m) => m.id),
      paint
    )
    lines.push(`  ${paint(`${i + 1})`, 'cyan')} ${(p.label ?? p.id).padEnd(labelWidth)}  ${status}  ${models}`)
  })
  const other = providers.length + 1
  // Examples come from the caller (only hosts not already configured), so the hint
  // can't advertise a provider that's already listed above. Falls back to the
  // always-available custom-endpoint option.
  const examples = opts.otherHostExamples?.trim() || 'add a custom endpoint'
  lines.push(`  ${paint(`${other})`, 'cyan')} ${otherLabel.padEnd(labelWidth)}  ${paint(examples, 'dim')}`)
  lines.push(
    paint(
      opts.firstRun
        ? 'Pick a number to set up, or press Enter to skip for now.'
        : 'Pick a provider to set or replace its key (Enter to cancel).',
      'dim'
    )
  )
  return lines.join('\n')
}

/**
 * The "e.g. …" hint for the Other-host row, built from catalog hosts NOT already
 * configured (so it never names a provider shown above) plus the custom-endpoint
 * escape hatch. Given the already-filtered addable list.
 */
export function otherHostExamples(addable: CatalogEntry[]): string {
  const names = addable.slice(0, 3).map((e) => e.label)
  return [...names, 'a custom endpoint'].join(', ')
}

/**
 * Interpret a numbered-menu answer where 1..count select a listed item, count+1 is a
 * trailing extra row, and anything else (blank, non-numeric, out of range) cancels.
 * Shared by the provider menu and the add-host menu below.
 */
function parseNumberedChoice(
  answer: string,
  count: number
): { kind: 'item'; index: number } | { kind: 'extra' } | { kind: 'cancel' } {
  const n = Number.parseInt(answer.trim(), 10)
  if (!Number.isInteger(n)) return { kind: 'cancel' }
  if (n >= 1 && n <= count) return { kind: 'item', index: n - 1 }
  if (n === count + 1) return { kind: 'extra' }
  return { kind: 'cancel' }
}

/** Interpret a provider-menu answer: a listed provider, the "Other host…" item, or cancel. */
export function parseProviderMenuChoice(
  answer: string,
  providerCount: number
): { kind: 'provider'; index: number } | { kind: 'other' } | { kind: 'cancel' } {
  const c = parseNumberedChoice(answer, providerCount)
  if (c.kind === 'item') return { kind: 'provider', index: c.index }
  if (c.kind === 'extra') return { kind: 'other' }
  return { kind: 'cancel' }
}

/** Render the "add a host" menu: one flat numbered list of catalog hosts, then "Custom endpoint". */
export function renderCatalogMenu(catalog: CatalogEntry[], paint: Painter): string {
  const lines: string[] = [
    paint('Add a host. Pick a known one, or point Houston at any OpenAI-compatible server:', 'bold')
  ]
  catalog.forEach((e, i) => {
    const note = e.requiresKey ? e.blurb : `${e.blurb} · no key needed`
    lines.push(`  ${paint(`${String(i + 1).padStart(2)})`, 'cyan')} ${e.label.padEnd(16)} ${paint(note, 'dim')}`)
  })
  const custom = catalog.length + 1
  lines.push(
    `  ${paint(`${String(custom).padStart(2)})`, 'cyan')} ${'Custom endpoint'.padEnd(16)} ${paint('enter your own label + base URL', 'dim')}`
  )
  lines.push(paint('Pick a host to add (Enter to cancel).', 'dim'))
  return lines.join('\n')
}

/** Interpret an add-host answer: a catalog host, the custom-endpoint item, or cancel. */
export function parseCatalogChoice(
  answer: string,
  catalogCount: number
): { kind: 'host'; index: number } | { kind: 'custom' } | { kind: 'cancel' } {
  const c = parseNumberedChoice(answer, catalogCount)
  if (c.kind === 'item') return { kind: 'host', index: c.index }
  if (c.kind === 'extra') return { kind: 'custom' }
  return { kind: 'cancel' }
}

/** The model to switch to after setting up a provider: its default, else its first model, else none. */
export function pickModelFor(provider: ProviderConfig): string | null {
  return provider.defaultModel ?? provider.models[0]?.id ?? null
}

/**
 * Paste a key (hidden) for `provider` and, if the provider has a model, switch to it.
 * Returns the provider+model to run, or null when no key was entered for a
 * key-required provider or the provider has no models yet (a freshly-added host).
 */
async function keyEntryFor(
  provider: ProviderConfig,
  deps: TuiDeps,
  paint: Painter,
  keyUrl: string | undefined
): Promise<{ providerId: string; model: string } | null> {
  const readSecret = deps.io.readSecret ?? deps.io.readLine
  const name = provider.label ?? provider.id
  if (keyUrl) deps.io.out(paint(`${name} → get a key at ${keyUrl}\n`, 'dim'))

  const optional = !provider.requiresKey
  deps.io.out(
    paint(
      optional
        ? 'Paste an API key if this endpoint needs one (Enter to skip; hidden):'
        : 'Paste your API key (hidden; not saved to shell or session history):',
      'dim'
    ) + '\n'
  )
  const key = (await readSecret(paint('key › ', 'green')))?.trim() ?? ''
  if (!key) {
    if (!optional) {
      deps.io.out(paint('· no key entered, nothing changed\n', 'dim'))
      return null
    }
  } else if (deps.setKey) {
    const { shadowedByEnv } = deps.setKey(provider.id, key)
    deps.io.out(paint(`· Key saved for ${name} (owner-only, on this profile). It's active now.\n`, 'dim'))
    if (shadowedByEnv) {
      deps.io.out(
        paint(
          `· Note: ${shadowedByEnv} is set in your environment and takes precedence over the stored key.\n`,
          'yellow'
        )
      )
    }
  }

  const model = pickModelFor(provider)
  if (!model) {
    deps.io.out(
      paint(`· ${name} has no models yet. Add one with:  /model ${provider.id}/<model-id>\n`, 'dim')
    )
    return null
  }
  // Persist the selection so the next launch skips setup and reopens this provider.
  deps.updateSettings?.({ selected: { providerId: provider.id, model } })
  deps.io.out(paint(`· Model set to ${provider.id} / ${model}.\n`, 'dim'))
  return { providerId: provider.id, model }
}

/**
 * The "Other host…" branch: add a catalog host or a custom OpenAI-compatible endpoint,
 * persist it, and return it (with any docs URL) for the key-entry step. Null on cancel
 * or when settings can't be written here.
 */
async function addHostInteractive(
  deps: TuiDeps,
  paint: Painter,
  newId: () => string
): Promise<{ provider: ProviderConfig; keyUrl?: string } | null> {
  if (!deps.updateSettings) {
    deps.io.out(paint('· adding a host is unavailable here\n', 'dim'))
    return null
  }
  const isMac = deps.isMac ?? process.platform === 'darwin'
  const settings = deps.getSettings()
  const configured = new Set(settings.providers.map((p) => p.id))
  const catalog = catalogForPlatform(isMac).filter((e) => !configured.has(e.id))

  deps.io.out(`${renderCatalogMenu(catalog, paint)}\n`)
  const ans = await deps.io.readLine(paint('host › ', 'green'))
  if (ans === null) return null
  const choice = parseCatalogChoice(ans, catalog.length)
  if (choice.kind === 'cancel') {
    deps.io.out(paint('· cancelled\n', 'dim'))
    return null
  }
  if (choice.kind === 'host') {
    const entry = catalog[choice.index]
    const provider = catalogEntryToProvider(entry)
    deps.updateSettings({ providers: [...settings.providers, provider] })
    deps.io.out(paint(`· Added ${entry.label} (${entry.id}) at ${entry.baseUrl}.\n`, 'dim'))
    return { provider, keyUrl: entry.docsUrl }
  }

  // Custom endpoint — label + base URL, mirroring the GUI's add-endpoint.
  const label = await deps.io.readLine('Label for this endpoint (e.g. My Router): ')
  if (label === null) return null
  const url = await deps.io.readLine('Base URL (e.g. https://router.internal/v1): ')
  if (url === null) return null
  const err = customEndpointError(label, url)
  if (err) {
    deps.io.out(paint(`· ${err}\n`, 'yellow'))
    return null
  }
  const provider = customEndpointToProvider(customProviderId(newId()), label.trim(), url.trim())
  deps.updateSettings({ providers: [...settings.providers, provider] })
  deps.io.out(paint(`· Added ${provider.label} (${provider.id}) at ${provider.baseUrl}.\n`, 'dim'))
  return { provider }
}

/**
 * The /login driver: pick a provider (or add a host), paste a key (hidden), and have
 * it take effect immediately. Returns the provider+model to switch to when setup
 * yields a usable model, or null when the user cancels/skips or only added a
 * model-less host (the caller then stays put / drops into the gated REPL). The caller
 * guards on deps.setKey before invoking this.
 */
async function runProviderSetup(
  deps: TuiDeps,
  paint: Painter,
  newId: () => string,
  o: { firstRun: boolean }
): Promise<{ providerId: string; model: string } | null> {
  const settings = deps.getSettings()
  const providers = keyableProviders(settings)
  // Only suggest hosts that aren't already configured, so the Other-host hint can't
  // name a provider already shown in the list above.
  const isMac = deps.isMac ?? process.platform === 'darwin'
  const configured = new Set(settings.providers.map((p) => p.id))
  const addable = catalogForPlatform(isMac).filter((e) => !configured.has(e.id))
  deps.io.out(
    `${renderProviderMenu(providers, paint, { firstRun: o.firstRun, otherHostExamples: otherHostExamples(addable) })}\n`
  )
  const ans = await deps.io.readLine(paint(o.firstRun ? 'setup › ' : 'login › ', 'green'))
  if (ans === null) return null
  const choice = parseProviderMenuChoice(ans, providers.length)
  if (choice.kind === 'cancel') {
    deps.io.out(paint('· no provider selected\n', 'dim'))
    return null
  }
  if (choice.kind === 'provider') {
    const target = providers[choice.index]
    return keyEntryFor(target, deps, paint, providerKeyUrl(target.id))
  }
  const added = await addHostInteractive(deps, paint, newId)
  if (!added) return null
  return keyEntryFor(added.provider, deps, paint, added.keyUrl)
}

// --- The interactive driver --------------------------------------------------

/** Abstract terminal I/O, so the driver runs headless in tests. */
export interface TuiIo {
  /** Print to the main output stream (stdout). */
  out: (s: string) => void
  /** Erase the current terminal line (the abandoned composer input on Ctrl-C). */
  clearLine?: () => void
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
   * Read a line without echoing it — for pasting an API key in the `/login` flow.
   * Resolves the typed value, or null on cancel (Ctrl-C) / EOF. Optional: off-TTY
   * and in tests it's absent, and the driver falls back to `readLine` (the value
   * still never reaches composer history, which only records real prompt lines).
   */
  readSecret?: (prompt: string) => Promise<string | null>
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
  /**
   * Present an arrow-key selectable picker (for approvals / `ask_user`). Resolves
   * with the committed value, a request to fall back to typing, or a cancel.
   * Optional — when absent (off-TTY / tests) the driver uses the typed prompt.
   */
  select?: (spec: PickerSpec) => Promise<PickerOutcome>
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
  /** Deliver the user's verdict on a `present_plan` review (accept / suggest / reject). */
  resolvePlan: (runId: string, callId: string, decision: PlanDecision) => void
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
  /** Load the workspace's custom `.houston/commands`, so `/<name>` runs one as a turn. */
  commands?: () => Promise<Command[]>
  /** Compact the given conversation on demand (the `/compact` command). */
  compact?: (id: string, providerId: string, model: string) => Promise<CompactResult>
  /** Persist a settings patch (for /hooks and /mcp editing). Absent ⇒ editing disabled. */
  updateSettings?: (patch: Partial<AppSettings>) => void
  /**
   * Persist an API key for a provider (the `/login` flow). Returns the env var
   * currently shadowing the id, if any, so the driver can warn. Absent ⇒ no
   * writable key store, so `/login` and the keyless-start wizard are disabled and
   * the driver falls back to printing the missing-key error.
   */
  setKey?: (id: string, key: string) => { shadowedByEnv: string | null }
  /** Whether the host is macOS — filters the provider catalog (e.g. oMLX). Defaults to the current platform. */
  isMac?: boolean
  /** Absolute path to settings.json, shown by /settings, /hooks, and /mcp. */
  settingsPath?: () => string
  /** Read + validate an image file for `/image`; returns the attachment or an error. */
  loadImage?: (path: string) => { image: ImageAttachment } | { error: string }
  /**
   * Open `initial` text in the user's `$VISUAL`/`$EDITOR` and return the edited
   * result (null if no editor is configured or the edit was aborted). Used by the
   * plan-review "edit" action so the user can revise a plan in a real editor.
   */
  editText?: (initial: string) => Promise<string | null>
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

  // Mutable session state. providerId/model may be null until a provider is set up:
  // an interactive session never ejects for a missing key (see below).
  let providerId: string | null
  let model: string | null
  const resolved = resolveHeadlessModel(settings, opts)
  if ('error' in resolved) {
    // A missing key (or nothing configured yet) is a setup step here, not a fatal
    // error: when a writable key store is wired, auto-launch the /login wizard
    // instead of exiting. A non-recoverable error (an unknown --provider, a provider
    // with no model) is a real usage mistake — print it and exit, don't misdirect the
    // user into key setup.
    if (resolved.recoverable && deps.setKey) {
      const setup = await runProviderSetup(deps, paint, newId, { firstRun: true })
      providerId = setup?.providerId ?? null
      model = setup?.model ?? null
      if (!setup) {
        deps.io.out(
          paint(
            '· No provider set up yet. Run /login any time, or set an env var\n' +
              '  (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) and restart.\n',
            'dim'
          )
        )
      }
    } else {
      deps.io.out(`${resolved.error}\n`)
      return 1
    }
  } else {
    providerId = resolved.providerId
    model = resolved.model
  }

  let policy = opts.approvalPolicy
  let messages: ChatMessage[] = []
  let activeRunId: string | null = null
  // The persisted conversation backing this session, created lazily on the first
  // turn (so merely opening and closing the REPL doesn't litter history). Null
  // until then, or after `/clear` starts a fresh one.
  let conversationId: string | null = null
  // Persist the running message log, best-effort. A store failure (disk full, bad
  // perms) must degrade to an ephemeral session, not crash the REPL mid-turn — a
  // throw here otherwise propagates out of startRun (no catch there) to a Fatal.
  let warnedPersistFail = false
  const persistMessages = (msgs: ChatMessage[]): void => {
    if (!deps.persist || !conversationId) return
    try {
      deps.persist.setMessages(conversationId, msgs)
    } catch (e) {
      if (!warnedPersistFail) {
        warnedPersistFail = true
        deps.io.out(paint(`· couldn't save the conversation (continuing unsaved): ${(e as Error).message}\n`, 'dim'))
      }
    }
  }
  const sessionCost: SessionCost = { inputTokens: 0, outputTokens: 0, cost: 0 }
  // Image attachments staged via /image, attached to (and cleared by) the next turn.
  let pendingImages: ImageAttachment[] = []
  // Estimated current context size (last turn's input tokens), for the status line.
  let contextTokens = 0
  // A synthetic message to run next without a composer read — used by the plan
  // review flow to auto-send "proceed" after the user accepts a plan.
  let autoInput: string | null = null
  const nowFn = deps.now ?? Date.now
  const columns = deps.columns ?? (() => 80)

  // Custom slash commands from the workspace's `.houston/commands`, loaded once for
  // the session. Merged with the first-party template commands (e.g. /review), which
  // win on a name collision. Typing `/<name>` runs the expanded template as a turn.
  let customCommands: Command[] = []
  if (deps.commands) {
    try {
      customCommands = await deps.commands()
    } catch {
      /* no custom commands — fine, carry on with the built-ins */
    }
  }
  const templateCommands = mergeCommands(BUILTIN_TEMPLATE_COMMANDS, customCommands)

  // Ctrl-C at the composer (no run in flight): first press discards the in-progress
  // input and re-prompts; a second press within the window exits, like a shell. The
  // composer read loop reads this to tell a reset from a real EOF.
  let composerInterrupt: 'reset' | 'exit' | null = null
  let lastComposerCtrlCAt = -Infinity
  deps.io.onInterrupt?.(() => {
    if (activeRunId) {
      deps.cancelRun(activeRunId)
      deps.io.stopSpinner?.()
      // Show that the interrupt registered — otherwise an aborted turn just stops
      // with no feedback — then release any approval/question prompt blocked on
      // input so the aborted run doesn't leave the loop waiting on a dead read.
      deps.io.out(paint('\n^C interrupted\n', 'dim'))
      deps.io.cancelRead?.()
      return
    }
    // No run → at the composer. Discard whatever's typed and re-prompt; a second
    // Ctrl-C in quick succession exits (the composer read loop acts on the flag).
    const t = nowFn()
    if (t - lastComposerCtrlCAt < 1500) {
      composerInterrupt = 'exit'
    } else {
      composerInterrupt = 'reset'
      deps.io.clearLine?.() // erase the abandoned input line
      deps.io.out(paint('(Ctrl-C again or Ctrl-D to exit)\n', 'dim'))
    }
    lastComposerCtrlCAt = t
    deps.io.cancelRead?.() // settle the outstanding composer read so the loop reacts
  })

  deps.io.out(
    `${paint('Houston', 'bold', 'cyan')} (interactive)\n` +
      `${paint(`  cwd:      ${opts.cwd}`, 'dim')}\n` +
      `${paint(
        providerId && model
          ? `  model:    ${providerId} / ${model}`
          : '  model:    (none yet, /login to set a key)',
        'dim'
      )}\n` +
      `${paint(`  approval: ${policy}`, 'dim')}\n` +
      `${paint('  /help for commands, Ctrl-D to exit', 'dim')}\n`
  )

  for (;;) {
    let text: string
    if (autoInput !== null) {
      // A plan-accept (or similar) queued a message; run it without a composer read.
      text = autoInput
      autoInput = null
    } else {
      // A persistent status line above the composer: model, policy, cwd, cost, and
      // context-window fill — so live session state is always visible. Before a
      // provider is set up it shows a "no model" prompt pointing at /login instead.
      deps.io.out(
        `${
          providerId && model
            ? renderStatusLine(
                { providerId, model, policy, cwd: opts.cwd, cost: sessionCost, contextTokens },
                columns(),
                paint
              )
            : renderNoModelStatus(policy, opts.cwd, paint)
        }\n`
      )
      // Read a (possibly multi-line) message: a trailing backslash or an open code
      // fence keeps reading, so a fenced snippet isn't split at the first newline.
      const composer = new ComposerBuffer()
      let raw: string | null = null
      let resetComposer = false
      for (;;) {
        // In an open code fence, hint how to send so a stray ``` can't trap the
        // composer with no visible way out (typing the closing ``` submits).
        const p = composer.pending
          ? paint(composer.inFence ? '… (``` to close and send) ' : '… ', 'dim')
          : composerPrompt(policy, paint)
        const line = await deps.io.readLine(p)
        if (line === null) {
          // Ctrl-C settles the read too: 'reset' discards this entry and re-prompts,
          // 'exit' (a second Ctrl-C) leaves like Ctrl-D; otherwise it's a real EOF.
          if (composerInterrupt === 'reset') {
            composerInterrupt = null
            resetComposer = true
            break
          }
          if (composerInterrupt === 'exit') {
            composerInterrupt = null
            break // raw stays null → exit below
          }
          if (composer.pending) raw = composer.flush() // EOF mid-entry → submit what we have
          break
        }
        const done = composer.push(line)
        if (done !== null) {
          raw = done
          break
        }
      }
      if (resetComposer) continue // Ctrl-C discarded the input — draw a fresh prompt
      if (raw === null) break // clean Ctrl-D (or a second Ctrl-C) at the composer → exit
      text = raw.trim()
      if (!text) continue
      // Persist composer submissions (commands included) for cross-restart recall;
      // approval/question answers go through a different read and aren't saved.
      deps.persistHistory?.(text)
    }

    if (text.startsWith('/')) {
      const result = parseSlashCommand(text, deps.getSettings(), templateCommands)
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
        let convs: ResumeEntry[]
        try {
          convs = query ? deps.persist.search(opts.cwd, query) : deps.persist.list(opts.cwd)
        } catch (e) {
          deps.io.out(paint(`· couldn't list sessions: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        deps.io.out(`${renderConversationList(convs, nowFn(), paint)}\n`)
        if (!convs.length) continue
        // discardPending like the other prompts, so type-ahead can't auto-select.
        const ans = await deps.io.readLine('> ', { discardPending: true })
        const id = ans === null ? null : parseResumeSelection(ans, convs)
        if (!id) {
          deps.io.out(paint('· cancelled\n', 'dim'))
          continue
        }
        let conv: { messages: ChatMessage[] } | null
        try {
          conv = deps.persist.get(id)
        } catch (e) {
          deps.io.out(paint(`· couldn't load that session: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        if (!conv) {
          deps.io.out(paint('· that session could not be loaded\n', 'dim'))
          continue
        }
        conversationId = id
        messages = conv.messages
        deps.io.out(paint(`· resumed: ${messages.length} message(s)\n`, 'dim'))
        continue
      }
      if (result.kind === 'fork') {
        if (!deps.persist || !conversationId) {
          deps.io.out(paint('· nothing to fork yet; start a conversation first\n', 'dim'))
          continue
        }
        let forked: { id: string } | null
        try {
          forked = deps.persist.fork(conversationId)
        } catch (e) {
          deps.io.out(paint(`· could not fork this session: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        if (!forked) {
          deps.io.out(paint('· could not fork this session\n', 'dim'))
          continue
        }
        conversationId = forked.id
        deps.io.out(paint('· forked: continuing on a copy, original left intact\n', 'dim'))
        continue
      }
      if (result.kind === 'capability') {
        if (!deps.capabilities) {
          deps.io.out(paint('· capability info is unavailable\n', 'dim'))
          continue
        }
        let snap: CapabilitySnapshot
        try {
          snap = await deps.capabilities()
        } catch (e) {
          deps.io.out(paint(`· couldn't read ${result.which}: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        const labels = { skills: 'Skills', agents: 'Agents' }
        deps.io.out(`${renderCapabilityList(labels[result.which], snap[result.which], paint)}\n`)
        continue
      }
      if (result.kind === 'settings') {
        renderSettingsOverview(deps, paint)
        continue
      }
      if (result.kind === 'hooks') {
        await runHooksCommand(result.action, deps, paint)
        continue
      }
      if (result.kind === 'mcp') {
        await runMcpCommand(result.action, deps, paint)
        continue
      }
      if (result.kind === 'login') {
        if (!deps.setKey) {
          deps.io.out(paint('· setting API keys isn’t available here\n', 'dim'))
          continue
        }
        const setup = await runProviderSetup(deps, paint, newId, { firstRun: false })
        if (setup) {
          providerId = setup.providerId
          model = setup.model
        }
        continue
      }
      if (result.kind === 'image') {
        if (!deps.loadImage) {
          deps.io.out(paint('· image attachments are unavailable\n', 'dim'))
          continue
        }
        if (pendingImages.length >= 8) {
          deps.io.out(paint('· already have 8 images staged (the max)\n', 'yellow'))
          continue
        }
        const loaded = deps.loadImage(result.path)
        if ('error' in loaded) {
          deps.io.out(paint(`· ${loaded.error}\n`, 'yellow'))
          continue
        }
        pendingImages.push(loaded.image)
        deps.io.out(paint(`· attached ${result.path} (${pendingImages.length} staged)\n`, 'dim'))
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
      if (result.kind === 'compact') {
        if (!deps.compact || !conversationId || !providerId || !model) {
          deps.io.out(paint('· nothing to compact yet; start a conversation first\n', 'dim'))
          continue
        }
        deps.io.out(paint('· compacting…\n', 'dim'))
        const res = await deps.compact(conversationId, providerId, model)
        if (res.ok && res.messages) {
          messages = res.messages
          deps.io.out(paint(`· compacted ${res.summarized} earlier message(s)\n`, 'dim'))
        } else if (res.ok) {
          deps.io.out(
            paint(
              res.reason === 'single-turn'
                ? '· single turn: /new starts a fresh chat to free up context\n'
                : '· nothing to compact yet\n',
              'dim'
            )
          )
        } else {
          deps.io.out(paint(`· couldn't compact: ${res.error ?? 'unknown error'}\n`, 'yellow'))
        }
        continue
      }
      if (result.kind === 'unknown') {
        deps.io.out(paint(`Unknown command: /${result.name}. Try /help.\n`, 'yellow'))
        continue
      }
      if (result.kind === 'prompt') {
        // A template command (custom `.houston/commands` or first-party /review):
        // run its expanded prompt as a normal turn. Fall through — don't `continue`.
        text = result.text
      } else {
        // 'handled' — informational commands print here where the state lives.
        handleInfoCommand(
          text,
          { providerId, model, policy, cwd: opts.cwd, sessionCost },
          deps,
          paint,
          customCommands
        )
        continue
      }
    }

    // A turn needs a model. Until a provider is set up, gate submission and point at
    // /login — never eject, so the user can set a key and keep this session.
    if (!providerId || !model) {
      deps.io.out(paint('No model is ready yet. Run /login to set an API key first.\n', 'yellow'))
      continue
    }

    // Preflight the key. A provider that needs one but has none — switched to via
    // /model, a saved selection whose key was since removed, etc. — would otherwise
    // start a run that fails deep in the adapter with a raw error and leave the
    // typed prompt dangling in `messages` (double-stacked onto the next turn).
    // Surface an actionable /login hint and skip the run instead.
    const activeProvider = deps.getSettings().providers.find((p) => p.id === providerId)
    if (activeProvider?.requiresKey && !activeProvider.hasKey) {
      deps.io.out(paint(`· ${providerId} has no API key — run /login to set one\n`, 'yellow'))
      continue
    }

    messages.push({
      role: 'user',
      content: text,
      ...(pendingImages.length ? { images: pendingImages } : {})
    })
    pendingImages = [] // consumed by this turn
    // Lazily open a persisted conversation on the first turn so the session
    // survives restarts and is resumable. Ephemeral when no store is injected, or
    // when the store can't be written (degrade rather than crash the REPL).
    if (deps.persist && !conversationId) {
      try {
        conversationId = deps.persist.create({ workspace: opts.cwd, providerId, model }).id
      } catch (e) {
        if (!warnedPersistFail) {
          warnedPersistFail = true
          deps.io.out(paint(`· couldn't start a saved conversation (continuing unsaved): ${(e as Error).message}\n`, 'dim'))
        }
      }
    }
    // Persist the user's message up front (like the GUI) so an early run error can't
    // lose the prompt or leave an empty "New chat" orphan in /resume and the sidebar.
    persistMessages(messages)
    const runId = newId()
    activeRunId = runId
    const req: AgentRunRequest = {
      runId,
      ...(conversationId ? { conversationId } : {}),
      workspace: opts.cwd,
      providerId,
      model,
      approvalPolicy: policy,
      messages,
      interactive: true
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
    // Per-turn token/cost tally. The loop emits a `usage` event per model round
    // (and per subagent), which would be noisy to print each time — the live
    // session total already sits in the status line above the composer. So we sum
    // the round usages here and print one compact summary when the turn ends.
    let turnInputTokens = 0
    let turnOutputTokens = 0
    let turnCost = 0
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

    // Track whether this turn produced a plan (assistant text) and how it ended,
    // to offer a plan→execute handoff when running under plan mode. `sawPlanReady`
    // suppresses that heuristic when the model used the real present_plan flow (which
    // already collected a decision), leaving the handoff only for text-only plans.
    let sawText = false
    let endedCleanly = false
    let sawPlanReady = false
    const send = (e: AgentEvent): void => {
      if (e.type === 'text') {
        sawText = true
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
            // Context (name, kind, unsandboxed warning) + the diff for a write.
            deps.io.out(`${renderApprovalPrompt(e, paint)}\n`)
            if (e.kind === 'write') {
              // The approval event carries the tool args (`tool_start` is emitted only
              // AFTER approval resolves, so `toolArgs` is still empty here for a write).
              // Prefer them so the user sees the edit before approving it; fall back to
              // toolArgs for any (older/test) event that omits args.
              const diff = extractDiff(e.args ?? toolArgs.get(e.callId) ?? {})
              if (diff) deps.io.out(`${colorizeDiff(diff, paint)}\n`)
            }
            let decision: 'allow' | 'deny' | 'always' | null = null
            if (deps.io.select) {
              const r = await deps.io.select({
                title: 'Choose:',
                options: [
                  { label: 'Allow', value: 'allow' },
                  { label: 'Deny', value: 'deny' },
                  { label: 'Always allow this kind', value: 'always' }
                ]
              })
              if (r.kind === 'commit') decision = r.value as 'allow' | 'deny' | 'always'
              else if (r.kind === 'cancel') decision = 'deny' // safe default
              // 'type' → fall through to the typed prompt below
            }
            if (decision === null) {
              const ans = await deps.io.readLine('> ', { discardPending: true })
              decision = parseApprovalAnswer(ans ?? '')
            }
            deps.resolveApproval(e.runId, e.callId, decision)
          })
          break
        case 'tool_question':
          enqueue(async () => {
            deps.io.out(`${renderQuestion(e.question, e.options, e.multiSelect ?? false, paint)}\n`)
            let answer: string | null = null
            // Only offer the arrow-key picker when there's something to pick — an
            // options-less question is a free-text prompt, so go straight to typing.
            if (deps.io.select && e.options.length > 0) {
              const r = await deps.io.select({
                title: e.question,
                multiSelect: e.multiSelect ?? false,
                options: e.options.map((o) => ({ label: o.label, value: o.label, description: o.description }))
              })
              if (r.kind === 'commit') answer = r.value
              // cancel/type → fall through so the user can still type a custom answer
            }
            if (answer === null) {
              const ans = await deps.io.readLine('> ', { discardPending: true })
              answer = resolveQuestionAnswer(ans ?? '', e.options, e.multiSelect ?? false)
            }
            deps.resolveQuestion(e.runId, e.callId, answer)
          })
          break
        case 'usage':
          sessionCost.inputTokens += e.inputTokens
          sessionCost.outputTokens += e.outputTokens
          sessionCost.cost += e.cost
          turnInputTokens += e.inputTokens
          turnOutputTokens += e.outputTokens
          turnCost += e.cost
          // Current context size ≈ the last MAIN round's input tokens; feeds the
          // status line. Subagent usage events carry inputTokens: 0, so guard
          // against them resetting the meter to zero mid-turn.
          if (e.inputTokens) contextTokens = e.inputTokens
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
          endedCleanly = e.stopReason === 'end_turn'
          // One compact cost summary for the whole turn (this turn + running
          // session), instead of a line per model round. Only when the turn
          // actually spent tokens; otherwise just a blank separator.
          if (turnInputTokens || turnOutputTokens) {
            const turnTally: SessionCost = {
              inputTokens: turnInputTokens,
              outputTokens: turnOutputTokens,
              cost: turnCost
            }
            deps.io.out(
              paint(
                `\n· turn ${formatSessionCost(turnTally)}  (session ${formatSessionCost(sessionCost)})\n`,
                'dim'
              )
            )
          } else {
            deps.io.out('\n')
          }
          break
        case 'plan_ready':
          // The agent presented a finished plan and is blocked awaiting a verdict.
          // Render it and collect the same accept / suggest / reject decision the
          // GUI's plan panel does, then unblock present_plan via resolvePlan.
          sawPlanReady = true
          enqueue(async () => {
            deps.io.out(`${renderPlan(e.plan, paint)}\n`)
            let action: PlanAction | null = null
            if (deps.io.select) {
              const r = await deps.io.select({
                title: 'Your decision:',
                options: PLAN_ACTIONS.map((a) => ({ label: a.label, value: a.action, description: a.description }))
              })
              if (r.kind === 'commit') action = r.value as PlanAction
              // cancel/type → fall through to the typed prompt
            }
            if (action === null) {
              const ans = await deps.io.readLine('> ', { discardPending: true })
              action = parsePlanAction(ans ?? '')
            }
            const decision = await planDecisionFor(action, e.plan, deps, paint)
            // Accepting flips the local policy so the composer + status line reflect
            // that Plan mode is off for the rest of the session (the loop flips the
            // run's own policy independently when the tool result is applied).
            if (decision.kind === 'accept') policy = decision.mode
            deps.resolvePlan(e.runId, e.callId, decision)
          })
          break
        case 'verification':
          deps.io.out(
            paint(`\n· verification ${e.passed ? 'passed' : 'failed'}\n`, e.passed ? 'dim' : 'yellow')
          )
          break
        case 'turn_start':
          // Emitted only when the main process auto-starts a queued follow-up turn;
          // the TUI drives its own composer and never uses that buffer, so ignore it.
          break
        default:
          assertNever(e, 'tui:unhandled agent event')
      }
    }

    await deps.startRun(req, send, (m: ChatMessage[]) => {
      messages = m
      // Mirror the GUI: persist the running message log so the session is durable
      // and resumable even if it's interrupted mid-turn. Guarded so a store failure
      // can't crash the run (a throw here has no catch on the startRun side).
      persistMessages(m)
    })
    deps.io.stopSpinner?.()
    // Drain any approval/question prompts still in flight before the next composer read.
    await prompts
    activeRunId = null

    // Plan-mode handoff: when a plan-mode turn presents a plan and stops, offer to
    // switch to auto-edit and carry it out — the decision point plan mode is for,
    // instead of manually /approval-ing and re-asking.
    if (policy === 'plan' && sawText && endedCleanly && !sawPlanReady) {
      deps.io.out(
        paint('\nPlan ready. Run it? [y] switch to auto-edit and proceed · anything else keeps planning\n', 'magenta')
      )
      const ans = await deps.io.readLine('> ', { discardPending: true })
      if (parseApprovalAnswer(ans ?? '') === 'allow') {
        policy = 'auto-edit'
        autoInput = 'Proceed with the plan you just described.'
        deps.io.out(paint('· switching to auto-edit and carrying out the plan\n', 'dim'))
      }
    }
  }

  deps.io.out(paint('\nBye.\n', 'dim'))
  return 0
}

function handleInfoCommand(
  line: string,
  state: {
    providerId: string | null
    model: string | null
    policy: ApprovalPolicy
    cwd: string
    sessionCost: SessionCost
  },
  deps: TuiDeps,
  paint: Painter,
  customCommands: Command[] = []
): void {
  const name = nameOf(line.slice(1).trim().split(/\s+/)[0])
  if (name === 'help') {
    deps.io.out(`${HELP_TEXT}\n`)
    if (customCommands.length) {
      const rows = customCommands.map((c) => `  ${`/${c.name}`.padEnd(20)}${c.description}`).join('\n')
      deps.io.out(paint(`\nCustom commands (.houston/commands):\n${rows}\n`, 'dim'))
    }
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
    const current =
      state.providerId && state.model ? `${state.providerId} / ${state.model}` : '(none, run /login)'
    deps.io.out(paint(`current: ${current}\n`, 'dim'))
    for (const p of settings.providers) {
      const ready = !p.requiresKey || p.hasKey
      const flag = ready ? '' : paint(' (no key)', 'yellow')
      const models = p.models.map((m) => m.id).join(', ') || paint('none', 'dim')
      deps.io.out(`  ${paint(p.id, 'cyan')}${flag}: ${models}\n`)
    }
    if (settings.providers.some((p) => p.requiresKey && !p.hasKey)) {
      deps.io.out(paint('  → run /login to add a key for a provider marked (no key)\n', 'dim'))
    }
  }
}

/**
 * The /settings hub: where the file lives, that the desktop app has the full panel,
 * and the safe subset editable from the terminal. Read-only — the editing verbs live
 * on /hooks and /mcp.
 */
function renderSettingsOverview(deps: TuiDeps, paint: Painter): void {
  const path = deps.settingsPath?.() ?? '(unknown)'
  const lines = [
    paint('Settings', 'bold'),
    `  file: ${path}`,
    '',
    '  The desktop app has the full settings panel: models, API keys, remote and',
    '  authenticated MCP servers, hooks, and more.',
    '  From the terminal you can edit a safe subset:',
    `    ${paint('/hooks', 'cyan')}   list, or  /hooks add  ·  /hooks remove <n>`,
    `    ${paint('/mcp', 'cyan')}     list, or  /mcp add (local stdio servers)  ·  /mcp remove <n>`,
    '',
    paint('  Changes are picked up on restart.', 'dim')
  ]
  deps.io.out(`${lines.join('\n')}\n`)
}

/** /hooks: list, add (guided), or remove a lifecycle hook. Persists via deps.updateSettings. */
async function runHooksCommand(action: SettingsAction, deps: TuiDeps, paint: Painter): Promise<void> {
  const hooks = deps.getSettings().hooks ?? []
  const path = deps.settingsPath?.() ?? '(unknown)'

  if (action.op === 'usage') {
    deps.io.out(paint('usage: /hooks   ·   /hooks add   ·   /hooks remove <n>\n', 'yellow'))
    return
  }
  if (action.op === 'list') {
    deps.io.out(`${renderHookList(hooks, paint)}\n${renderSettingsFooter(path, paint)}\n`)
    return
  }
  if (!deps.updateSettings) {
    deps.io.out(paint('· editing settings is unavailable here\n', 'dim'))
    return
  }
  if (action.op === 'remove') {
    if (action.index > hooks.length) {
      deps.io.out(paint(`· no hook #${action.index} (there ${hooks.length === 1 ? 'is 1' : `are ${hooks.length}`})\n`, 'yellow'))
      return
    }
    const removed = hooks[action.index - 1]
    // Rebuild without the removed entry (never mutate the settings array in place).
    deps.updateSettings({ hooks: hooks.filter((_, i) => i !== action.index - 1) })
    deps.io.out(paint(`· removed hook ${action.index} (${removed.event} ${removed.matcher}). Applies on restart.\n`, 'dim'))
    return
  }

  // op === 'add' — guided, one field per prompt.
  deps.io.out(`Add a hook.\n  ${paint('events:', 'dim')} ${HOOK_EVENTS.map((e, i) => `${i + 1}) ${e}`).join('   ')}\n`)
  const evAns = await deps.io.readLine('event (number or name): ')
  if (evAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const matcherAns = await deps.io.readLine('matcher (tool name or glob, e.g. edit_file or *; blank = any): ')
  if (matcherAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cmdAns = await deps.io.readLine('command (shell to run): ')
  if (cmdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))

  const built = buildHook(resolveHookEventInput(evAns), matcherAns, cmdAns)
  if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))

  deps.io.out(`\n${paint('hook:', 'dim')} ${built.event}  ${built.matcher}  → ${built.command}\n`)
  const ok = await deps.io.readLine('Add this hook? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '') !== 'allow') return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings({ hooks: [...hooks, built] })
  deps.io.out(paint('· hook added. Applies on restart.\n', 'dim'))
}

/**
 * /mcp: list, add (guided, stdio only), or remove an MCP server. Persists via
 * deps.updateSettings. The add flow never collects a URL or auth headers, so it
 * can't touch the header-secret path the CLI intentionally doesn't write; remote or
 * authenticated servers are directed to the desktop app.
 */
async function runMcpCommand(action: SettingsAction, deps: TuiDeps, paint: Painter): Promise<void> {
  const servers = deps.getSettings().mcpServers ?? []
  const path = deps.settingsPath?.() ?? '(unknown)'

  if (action.op === 'usage') {
    deps.io.out(paint('usage: /mcp   ·   /mcp add   ·   /mcp remove <n>\n', 'yellow'))
    return
  }
  if (action.op === 'list') {
    deps.io.out(`${renderMcpList(servers, paint)}\n${renderSettingsFooter(path, paint)}\n`)
    deps.io.out(paint('Remote (URL) or authenticated servers: add them in the desktop app.\n', 'dim'))
    return
  }
  if (!deps.updateSettings) {
    deps.io.out(paint('· editing settings is unavailable here\n', 'dim'))
    return
  }
  if (action.op === 'remove') {
    if (action.index > servers.length) {
      deps.io.out(paint(`· no MCP server #${action.index} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`, 'yellow'))
      return
    }
    const removed = servers[action.index - 1]
    deps.updateSettings({ mcpServers: servers.filter((_, i) => i !== action.index - 1) })
    deps.io.out(paint(`· removed MCP server ${action.index} (${removed.name ?? removed.id}). Applies on restart.\n`, 'dim'))
    return
  }

  // op === 'add' — local stdio servers only.
  deps.io.out(paint('Add a local (stdio) MCP server. For remote or authenticated servers, use the desktop app.\n', 'dim'))
  const nameAns = await deps.io.readLine('name (letters, numbers, - or _): ')
  if (nameAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cmdAns = await deps.io.readLine('command to spawn (e.g. npx): ')
  if (cmdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const argsAns = await deps.io.readLine('args (space-separated, optional): ')
  if (argsAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))

  const built = buildStdioMcpServer(servers.map((s) => s.id), nameAns, cmdAns, argsAns)
  if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))

  deps.io.out(
    `\n${paint('server:', 'dim')} ${built.name}  [stdio]  ${built.command}${built.args?.length ? ` ${built.args.join(' ')}` : ''}\n`
  )
  const ok = await deps.io.readLine('Add this server? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '') !== 'allow') return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings({ mcpServers: [...servers, built] })
  deps.io.out(paint('· MCP server added. Applies on restart.\n', 'dim'))
}
