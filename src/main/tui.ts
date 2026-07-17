import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  APPROVAL_POLICIES,
  HOOK_EVENTS,
  folderTrustState,
  isApprovalPolicy,
  upsertFolderTrust,
  type AppSettings,
  type ApprovalPolicy,
  type Hook,
  type McpServerConfig,
  type ProviderConfig
} from '@shared/types'
import { loadProjectConfig } from './agent/projectConfig'
import {
  catalogForPlatform,
  catalogEntryToProvider,
  customEndpointError,
  customEndpointToProvider,
  customProviderId,
  type CatalogEntry
} from '@shared/provider-catalog'
import { providerKeyUrl } from '@shared/provider-keys'
import type { FileDiffPreview } from '@shared/diff'
import {
  BUILTIN_TEMPLATE_COMMANDS,
  expandTemplate,
  mergeCommands,
  resolveCommand,
  type Command
} from '@shared/commands'
import type { CompactResult } from './agent/compact'
import type { McpServerStatus } from './mcp/manager'
import { needsLegalAcceptance, LICENSE_URL, PRIVACY_URL, TERMS_URL } from '@shared/legal'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  ElicitationResult,
  PlanAcceptMode,
  PlanDecision,
  PlanPayload,
  QuestionOption,
  ReasoningEffort,
  ToolApprovalDecision
} from '@shared/agent'
import { buildElicitationContent } from '@shared/mcp'
import type { ImageAttachment } from '@shared/images'
import { isReasoningEffort, REASONING_EFFORTS } from '@shared/agent'
import { contextWindowFor, contextPercent } from '@shared/usage'
import { pickDefaultModel } from '@shared/models'
import { assertNever } from '@shared/assert'
import { truncateVisible, stripControlChars } from './tui-wrap'
import { MarkdownStream } from './markdown-ansi'
import { renderPreviewView } from './tui-diff'
import { htmlToAnsi } from './syntax'
import type { PickerSpec, PickerOutcome } from './tui-picker'
import { signalFor, idleTitle, type TerminalSignal } from './tui-notify'
import { workspaceLabel } from '@shared/notify'
import { ComposerBuffer } from './tui-composer'
import { buildDoctorReport, renderDoctor, type DoctorFacts } from './tui-doctor'
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
  /**
   * Reopen the most recent chat in this folder at launch (`--continue`), or a
   * specific one (`--resume <id>`).
   *
   * Headless has had both since it existed; the terminal had neither, so picking
   * up where you left off meant starting a session and then running /resume — one
   * more step, every time, for the most ordinary thing you do.
   */
  continueSession?: boolean
  resumeId?: string
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
  let continueSession = false
  let resumeId: string | undefined

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
    } else if (name === '--continue') {
      continueSession = true
    } else if (name === '--resume') {
      const { value, next } = flagValue(argv, i)
      resumeId = value
      i = next
    }
  }

  if (!interactive && !defaultInteractive) return null
  return {
    cwd,
    providerId,
    model,
    approvalPolicy,
    acceptTerms,
    color: true,
    ...(continueSession ? { continueSession } : {}),
    ...(resumeId ? { resumeId } : {})
  }
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
  /** High-intensity foregrounds: readable on a DARK background. */
  dark: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[91m', green: '\x1b[92m', yellow: '\x1b[93m',
    blue: '\x1b[94m', magenta: '\x1b[95m', cyan: '\x1b[96m'
  },
  /**
   * Standard (darker) foregrounds for a LIGHT background. Yellow especially is
   * unreadable on white in its high-intensity form, and blue/cyan wash out.
   */
  light: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
    blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m'
  },
  /**
   * Colorblind-safe: red/green carry most of the meaning in a diff, and that is
   * the single most common form of color blindness. This maps them to blue and
   * yellow — distinguishable under deuteranopia and protanopia — rather than
   * dropping color entirely the way `mono` does.
   */
  colorblind: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '\x1b[38;5;208m', green: '\x1b[38;5;33m', yellow: '\x1b[38;5;178m',
    blue: '\x1b[38;5;33m', magenta: '\x1b[38;5;171m', cyan: '\x1b[38;5;37m'
  },
  mono: {
    reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
    red: '', green: '', yellow: '', blue: '', magenta: '', cyan: ''
  }
} as const

/**
 * `bright` was the old name for what is now `dark`. Kept as an alias so a saved
 * setting (or muscle memory) doesn't break — a theme name that used to work and
 * now errors is a worse experience than one extra line here.
 */
const THEME_ALIASES: Record<string, ThemeName> = { bright: 'dark' }

/** Resolve a theme name, honoring the aliases. */
export function resolveTheme(name: string): ThemeName | null {
  const n = name.trim().toLowerCase()
  if (isThemeName(n)) return n
  return THEME_ALIASES[n] ?? null
}

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
  // The one-time full-auto shell-network consent gates the sandbox's network, not the
  // command — frame it as a network grant so "deny" reads as "run offline", not "block".
  if (ev.shellNetwork) {
    const head = paint('Allow shell commands to reach the network this run?', 'bold')
    const note = paint(
      '  Shell runs in a sandbox that can read your files; declining runs commands offline.',
      'dim'
    )
    return `\n${head}\n  ${ev.summary}\n${note}\n${paint('  [y] allow network   [n] no network   [a] allow for run', 'dim')}`
  }
  const warn =
    ev.kind === 'shell' && ev.sandboxed === false
      ? `\n${paint('⚠ runs UNSANDBOXED (no OS confinement on this host)', 'yellow', 'bold')}`
      : ''
  const head = paint(`Approve ${ev.name}`, 'bold')
  const kind = paint(`[${ev.kind}]`, 'dim')
  return (
    `\n${head} ${kind}\n  ${ev.summary}${warn}\n` +
    paint('  [y] allow   [n] deny   [a] allow for run   [!] always allow   [x] always deny', 'dim') +
    paint('\n  …or type why not, and that goes back to the agent', 'dim')
  )
}

/**
 * Map a freeform approval answer to a decision, plus any guidance the user typed.
 *
 * Anything unrecognized is a DENY (the safe default), but it is not discarded: a
 * typed sentence is the user explaining what to do instead, so it rides back to
 * the model as the reason. Previously that explanation was silently dropped and
 * the model saw a bare refusal, which is the worst of both — the user thinks they
 * gave direction, and the agent retries a variant of the same thing.
 */
export function parseApprovalAnswer(answer: string): { decision: ToolApprovalDecision; note?: string } {
  const raw = answer.trim()
  const a = raw.toLowerCase()
  if (a === 'y' || a === 'yes' || a === 'allow') return { decision: 'allow' }
  if (a === 'a' || a === 'always' || a === 'allow-run') return { decision: 'always' }
  if (a === '!' || a === 'always-allow') return { decision: 'rule-allow' }
  if (a === 'x' || a === 'always-deny') return { decision: 'rule-deny' }
  if (a === 'n' || a === 'no' || a === 'deny' || a === '') return { decision: 'deny' }
  // Free text: a denial WITH a reason, which is the whole point.
  return { decision: 'deny', note: raw }
}

/**
 * The decisions offered in the approval picker. `rule-allow` / `rule-deny` persist
 * a permission rule; the core has always supported them, but the terminal used to
 * type them away and offer only allow/deny/always.
 */
export const APPROVAL_OPTIONS: { label: string; value: ToolApprovalDecision | 'deny-note'; description: string }[] = [
  { label: 'Allow', value: 'allow', description: 'run this once' },
  { label: 'Allow for run', value: 'always', description: 'stop asking for this kind this session' },
  { label: 'Always allow', value: 'rule-allow', description: 'save a permission rule' },
  { label: 'Deny', value: 'deny', description: 'refuse this once' },
  { label: 'Deny with a reason…', value: 'deny-note', description: 'tell the agent what to do instead' },
  { label: 'Always deny', value: 'rule-deny', description: 'save a permission rule' }
]

/**
 * Render the per-file diff preview the main process computed against the files'
 * real pre-write contents (see `previewWrite`) as unified-diff text.
 *
 * Preferred over {@link extractDiff}, which can only work from the call's arguments
 * and therefore cannot know what a file already held: it shows a `write_file` over
 * an existing file as an all-new file, and has nothing to show for a `multi_edit`.
 * Returns null when there is no preview to render, so the caller can fall back.
 */
export function renderPreviewDiff(preview: FileDiffPreview[]): string | null {
  if (preview.length === 0) return null
  return preview
    .map((f) => {
      const tag = f.created ? ' (new file)' : f.deleted ? ' (deleted)' : ''
      const from = f.renamedFrom ?? f.path
      const body = f.diff
        .map((l) =>
          // A `skip` marks unchanged lines folded away; it is a note, not a line of
          // the file, so it must not render with a diff sign.
          l.type === 'skip' ? `⋯ ${l.text}` : `${l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '}${l.text}`
        )
        .join('\n')
      const more = f.truncated ? '\n… diff shortened; the change continues past this point' : ''
      return `--- ${from}\n+++ ${f.path}${tag}\n${body}${more}`
    })
    .join('\n')
}

/**
 * Reconstruct a reviewable diff from a write tool's arguments (captured at
 * `tool_start`), so an edit can be seen before it's approved. Handles the shapes
 * of the built-in write tools: `apply_patch` (a ready patch envelope), `edit_file`
 * (old→new strings), and `write_file` (whole-file content). Returns null when no
 * diff can be derived.
 *
 * This is the FALLBACK for events that carry no preview (an older log, or a write
 * whose effect couldn't be modelled). Prefer {@link renderPreviewDiff}.
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
/** How many lines of a failure are shown by default — enough to see the cause. */
export const FAILURE_LINES = 10
/** How many lines of a successful result `/verbose` shows before collapsing. */
export const VERBOSE_LINES = 40

/**
 * The transcript line(s) for a finished tool call.
 *
 * A success collapses to one dim line: the transcript is a conversation, not a
 * log, and forty lines of `ls` output buries it. But a FAILURE used to collapse
 * to `✗ run_shell failed` and throw the error away entirely — the one case where
 * the output is the whole point, and the user was left to guess (or ask the agent
 * what it just saw). Failures now show their first lines.
 *
 * `verbose` opens successes up too, and `/output` recovers any result in full
 * from the persisted log afterwards.
 */
export function renderToolResult(
  name: string,
  ok: boolean,
  output: string,
  paint: Painter,
  opts: { verbose?: boolean } = {}
): string {
  const lines = output.split('\n')
  if (!ok) {
    const body = trimBlank(lines)
    if (!body.length) return paint(`  ✗ ${name} failed`, 'red')
    const shown = body.slice(0, FAILURE_LINES).map((l) => paint(`    ${truncate(l, 200)}`, 'dim'))
    const more =
      body.length > FAILURE_LINES
        ? [paint(`    … ${body.length - FAILURE_LINES} more lines (/output to see it all)`, 'dim')]
        : []
    return [paint(`  ✗ ${name} failed`, 'red'), ...shown, ...more].join('\n')
  }
  if (opts.verbose) {
    const body = trimBlank(lines)
    if (!body.length) return ''
    const shown = body.slice(0, VERBOSE_LINES).map((l) => paint(`    ${truncate(l, 200)}`, 'dim'))
    const more =
      body.length > VERBOSE_LINES
        ? [paint(`    … ${body.length - VERBOSE_LINES} more lines (/output to see it all)`, 'dim')]
        : []
    return [...shown, ...more].join('\n')
  }
  const firstLine = lines.find((l) => l.trim()) ?? ''
  const snippet = truncate(firstLine.trim(), 80)
  return snippet ? paint(`  ↳ ${snippet}`, 'dim') : ''
}

/** Drop leading/trailing blank lines, so a padded result doesn't render as gaps. */
function trimBlank(lines: string[]): string[] {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

/**
 * The tool results this session recorded, oldest first, read back out of the
 * message log the run loop persists. Nothing new is stored: the full output was
 * always there, it just had no way out to the terminal.
 */
export function toolResultsFrom(messages: ChatMessage[]): { name: string; output: string }[] {
  return messages
    .filter((m) => m.role === 'tool')
    .map((m) => ({ name: m.toolName ?? 'tool', output: m.content }))
}

/** Cap on what `/output` prints, so recovering a huge result can't flood the terminal. */
export const OUTPUT_LINES = 500

/**
 * Render one recovered tool result. `index` is 1-based from the most recent, so
 * `/output` (1) is "what just happened" — the overwhelmingly common ask.
 */
export function renderRecoveredOutput(
  results: { name: string; output: string }[],
  index: number,
  paint: Painter
): string {
  if (!results.length) return paint('· no tool output in this conversation yet', 'dim')
  if (index < 1 || index > results.length) {
    return paint(`· no tool call #${index} (this conversation has ${results.length})`, 'yellow')
  }
  const picked = results[results.length - index]
  const lines = picked.output.split('\n')
  const shown = lines.slice(0, OUTPUT_LINES)
  const head = paint(`▣ ${picked.name}`, 'bold') + paint(`  (${index} back, ${lines.length} lines)`, 'dim')
  const more =
    lines.length > OUTPUT_LINES ? [paint(`… ${lines.length - OUTPUT_LINES} more lines not shown`, 'dim')] : []
  return [head, ...shown, ...more].join('\n')
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
export function spinnerFrame(
  tick: number,
  label: string,
  elapsedSec: number,
  paint: Painter,
  /**
   * What the user is typing while the agent works, how many messages they have
   * queued, and which approval mode is in force. The spinner line doubles as the
   * mid-run composer and the mid-run status bar: it is the one line already being
   * redrawn, so all of this costs no extra screen space and cannot tear the
   * transcript.
   */
  opts: { draft?: string; queued?: number; mode?: string } = {}
): string {
  const i = ((tick % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length
  const head = `${paint(SPINNER_FRAMES[i], 'cyan')} ${label} ${paint(`${elapsedSec}s`, 'dim')}`
  // The approval mode, kept visible WHILE the turn runs: the composer's status line
  // is gone exactly when "how much is running without asking?" matters most.
  const mode = opts.mode ? paint(`  [${opts.mode}]`, 'dim') : ''
  const queued = opts.queued ? paint(`  (${opts.queued} queued)`, 'cyan') : ''
  // The draft is shown verbatim so people can see what they typed; it is their own
  // keystrokes, and the decoder never lets a control character into it.
  const draft = opts.draft ? `  ${paint('›', 'green')} ${opts.draft}` : ''
  return `${head}${mode}${queued}${draft}`
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
export function renderNoModelStatus(
  policy: ApprovalPolicy,
  cwd: string,
  width: number,
  paint: Painter
): string {
  const line = [
    paint('no model (run /login)', 'yellow'),
    paint(policy, 'dim'),
    paint(shortCwd(cwd), 'dim')
  ].join(paint(' · ', 'dim'))
  // Truncate like renderStatusLine so a long cwd can't wrap the single-line footer.
  return truncateVisible(line, Math.max(0, width))
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
  /**
   * Rewrite the backing conversation's provider/model. `create` records them once,
   * but the session's active model drifts when the user switches with `/model` or
   * resumes a chat first created under a different model — leaving the stored value
   * stale, which mis-attributes the usage scorecard and makes a GUI re-open reopen
   * on the wrong model. The GUI keeps this in step via `updateConversationMeta` on
   * every send; this is the terminal's counterpart.
   */
  setModel: (id: string, providerId: string, model: string) => void
  list: (workspace: string) => ResumeEntry[]
  get: (id: string) => { messages: ChatMessage[] } | null
  /** Recent sessions in this folder whose title/content matches `query`. */
  search: (workspace: string, query: string) => ResumeEntry[]
  /** Duplicate a conversation (fresh id, copied history); null if it can't be forked. */
  fork: (id: string) => { id: string } | null
}

/**
 * A chat the agent spawned to run alongside this one (`spawn_session`), usually
 * on its own git branch and worktree.
 */
export interface BackgroundSession {
  id: string
  title: string
  running: boolean
  startedAt: number
  /** The branch it is working on, when it was given its own worktree. */
  branch?: string
}

/**
 * Render the background sessions this session started.
 *
 * The agent could always fan work out from the terminal, but the only sign of it
 * was one line when a session FINISHED — so parallel work was invisible while it
 * mattered, and there was no way to see what branch it was on or to open it.
 */
export function renderBackgroundSessions(
  sessions: BackgroundSession[],
  now: number,
  paint: Painter
): string {
  if (!sessions.length) {
    return paint('No background sessions started from this chat yet.', 'dim')
  }
  // Running first: they're the ones you might want to watch or wait for.
  const ordered = [...sessions].sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
  const lines = [paint('Background sessions:', 'bold')]
  ordered.forEach((s, i) => {
    const state = s.running ? paint('● running', 'cyan') : paint('✓ finished', 'green')
    const branch = s.branch ? paint(`  ${s.branch}`, 'magenta') : ''
    const when = paint(formatRelativeTime(s.startedAt, now), 'dim')
    lines.push(`  ${paint(String(i + 1), 'cyan')}. ${state}  ${s.title}${branch}  ${when}`)
  })
  lines.push(paint('  Enter a number to open one, or anything else to cancel', 'dim'))
  return lines.join('\n')
}

/** Map a `/sessions` selection to a conversation id, or null to cancel. */
export function parseSessionSelection(answer: string, sessions: BackgroundSession[]): string | null {
  const ordered = [...sessions].sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)
  const n = Number(answer.trim())
  if (Number.isInteger(n) && n >= 1 && n <= ordered.length) return ordered[n - 1].id
  return null
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
  // Count/slice by code point so a cut never lands inside a surrogate pair (which
  // would emit a broken half-character). `.length`/`.slice` work in code units.
  const cps = [...s]
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s
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
  /** Attach the image on the clipboard (/image with no path, /paste). */
  | { kind: 'paste-image' }
  | { kind: 'set-approval'; policy: ApprovalPolicy }
  | { kind: 'set-model'; providerId: string; model: string }
  | { kind: 'compact' }
  /** The settings overview hub (/settings). */
  | { kind: 'settings' }
  /** Environment diagnostics (/doctor). */
  | { kind: 'doctor' }
  /** Show or set how hard the model thinks before answering (/reasoning). */
  | { kind: 'reasoning'; effort?: ReasoningEffort }
  /** Show more (or less) of each tool's output as it runs (/verbose). */
  | { kind: 'verbose'; on?: boolean }
  /** Reprint a past tool result in full (/output [n]). */
  | { kind: 'output'; index: number }
  /** List (and open) the background sessions the agent spawned (/spawned). */
  | { kind: 'spawned' }
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
    case 'spawned':
      return { kind: 'spawned' }
    case 'fork':
      return { kind: 'fork' }
    case 'skills':
    case 'agents':
      return { kind: 'capability', which: name }
    case 'settings':
      return { kind: 'settings' }
    case 'doctor':
      return { kind: 'doctor' }
    case 'reasoning':
    case 'think': {
      const a = arg.trim().toLowerCase()
      if (isReasoningEffort(a)) return { kind: 'reasoning', effort: a }
      return { kind: 'reasoning' } // no/invalid arg → the driver reports the current one
    }
    case 'verbose': {
      const a = arg.trim().toLowerCase()
      if (a === 'on') return { kind: 'verbose', on: true }
      if (a === 'off') return { kind: 'verbose', on: false }
      return { kind: 'verbose' } // bare /verbose toggles
    }
    case 'output': {
      // `/output` means "what just happened"; a number counts back from there.
      const n = Number.parseInt(arg.trim(), 10)
      return { kind: 'output', index: Number.isInteger(n) && n >= 1 ? n : 1 }
    }
    case 'hooks':
      return { kind: 'hooks', action: parseSettingsAction(arg) }
    case 'mcp':
      return { kind: 'mcp', action: parseSettingsAction(arg) }
    case 'login':
    case 'providers':
      return { kind: 'login' }
    case 'theme': {
      const t = resolveTheme(arg)
      if (t) return { kind: 'set-theme', theme: t }
      return { kind: 'handled' } // no/invalid arg → driver lists themes
    }
    case 'image':
      // A bare /image means "paste what I just copied" — the overwhelmingly common
      // reason to attach an image mid-conversation. It used to print usage.
      return arg ? { kind: 'image', path: arg } : { kind: 'paste-image' }
    case 'paste':
      return { kind: 'paste-image' }
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
  '  /spawned              list the background sessions the agent started; open one',
  '  /fork                 branch the current session into a copy',
  '  /cost                 show session token + cost totals',
  '  /skills /agents       list workspace skills / custom agents',
  '  /settings             settings overview + where to edit them',
  '  /doctor               check your setup (model, sandbox, tools, MCP)',
  '  /reasoning [effort]   show or set thinking effort (off | low | medium | high | xhigh)',
  '  /verbose [on|off]     show each tool\'s full output as it runs',
  '  /output [n]           reprint a tool result in full (n back; default the last)',
  '  /hooks [add|remove n] list or edit lifecycle hooks',
  '  /mcp [verb n]         list MCP servers; tools · add (stdio) · remove · login · logout <n>',
  '  /theme [name]         list or switch color theme (default | bright | mono)',
  '  /image [path]         attach an image — from your clipboard, or a file',
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

// Lifecycle events a hook can bind to: re-exported from @shared/types (the one
// list validators and UIs share) so existing terminal imports keep working.
export { HOOK_EVENTS }

/** What the user asked /hooks or /mcp to do. Indexed ops carry a 1-based index. */
export type SettingsAction =
  | { op: 'list' }
  | { op: 'add' }
  | { op: 'remove'; index: number }
  /** List a server's tools (/mcp tools <n>). /mcp only. */
  | { op: 'tools'; index: number }
  /** OAuth sign-in for a remote MCP server (/mcp login <n>). /mcp only. */
  | { op: 'login'; index: number }
  /** Forget a remote MCP server's OAuth tokens (/mcp logout <n>). /mcp only. */
  | { op: 'logout'; index: number }
  | { op: 'usage' }

/** Parse the argument of /hooks or /mcp into an action. Bare command → list. */
export function parseSettingsAction(arg: string): SettingsAction {
  const [verb, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  if (!verb) return { op: 'list' }
  if (verb === 'add') return { op: 'add' }
  const indexed = (op: 'remove' | 'login' | 'logout' | 'tools'): SettingsAction => {
    const n = Number.parseInt(rest[0] ?? '', 10)
    if (Number.isInteger(n) && n >= 1) return { op, index: n }
    return { op: 'usage' }
  }
  if (verb === 'tools') return indexed('tools')
  if (verb === 'remove' || verb === 'rm' || verb === 'delete') return indexed('remove')
  if (verb === 'login' || verb === 'signin') return indexed('login')
  if (verb === 'logout' || verb === 'signout') return indexed('logout')
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
 * No url/headers by construction: remote transports are the desktop app's domain
 * (or `/mcp login` for OAuth), so a terminal-added server is always a local
 * process. `envStr` is space-separated KEY=value pairs; values are secrets, moved
 * into the secret store by the settings save (see store.ts).
 */
export function buildStdioMcpServer(
  existingIds: string[],
  name: string,
  command: string,
  argsStr: string,
  cwdStr = '',
  envStr = ''
): McpServerConfig | { error: string } {
  const id = name.trim()
  if (!/^[\w-]+$/.test(id)) {
    return { error: 'name must be letters, numbers, hyphens or underscores (no spaces)' }
  }
  if (existingIds.includes(id)) return { error: `an MCP server named "${id}" already exists` }
  const cmd = command.trim()
  if (!cmd) return { error: 'a command to spawn is required (e.g. npx)' }
  const args = argsStr.trim() ? argsStr.trim().split(/\s+/) : undefined
  const env: Record<string, string> = {}
  for (const pair of envStr.trim() ? envStr.trim().split(/\s+/) : []) {
    const eq = pair.indexOf('=')
    const key = eq > 0 ? pair.slice(0, eq) : ''
    if (!/^[A-Za-z_]\w*$/.test(key)) {
      return { error: `env must be KEY=value pairs separated by spaces (got "${pair}")` }
    }
    env[key] = pair.slice(eq + 1)
  }
  const cwd = cwdStr.trim()
  return {
    id,
    name: id,
    transport: 'stdio',
    command: cmd,
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    enabled: true
  }
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
 * `headers`/`env` maps, whose values are secrets (masked on read, but we don't
 * print them at all). `statuses` (from the manager) adds a live connection badge:
 * connected tool count, needs-sign-in, or the connect error.
 */
export function renderMcpList(
  servers: McpServerConfig[],
  paint: Painter,
  statuses: McpServerStatus[] = []
): string {
  if (!servers.length) return paint('No MCP servers configured.', 'dim')
  const statusById = new Map(statuses.map((s) => [s.id, s]))
  return servers
    .map((s, i) => {
      const transport = s.transport ?? (s.url && !s.command ? 'http' : 'stdio')
      const detail =
        transport === 'stdio'
          ? `${s.command}${s.args?.length ? ` ${s.args.join(' ')}` : ''}`
          : (s.url ?? '')
      const off = s.enabled === false ? paint(' (disabled)', 'dim') : ''
      const auth = transport !== 'stdio' && s.hasOAuth ? paint(' (signed in)', 'green') : ''
      const st = statusById.get(s.id)
      const badge =
        st?.state === 'connected'
          ? paint(`  ✓ connected, ${st.tools ?? 0} tool${st.tools === 1 ? '' : 's'}`, 'green')
          : st?.state === 'needs-auth'
            ? paint(`  ! needs sign-in (/mcp login ${i + 1})`, 'yellow')
            : st?.state === 'error'
              ? paint(`  ✗ ${stripControlChars(st.error ?? 'failed to connect')}`, 'red')
              : ''
      return `  ${paint(`${i + 1}.`, 'dim')} ${paint(s.name ?? s.id, 'cyan')}${off}${auth}  ${paint(`[${transport}]`, 'dim')}  ${detail}${badge}`
    })
    .join('\n')
}

/**
 * A server's tools, by name.
 *
 * `/mcp` could tell you a server was connected and how MANY tools it had, never
 * which — so "what did I just give the agent?" had no answer short of reading the
 * server's own docs. That is the question that decides whether you trust it.
 */
export function renderMcpTools(name: string, status: McpServerStatus | undefined, paint: Painter): string {
  if (!status) return paint(`· "${name}" has not connected yet; its tools are unknown until it does`, 'dim')
  if (status.state === 'needs-auth') return paint(`· "${name}" needs sign-in first (/mcp login)`, 'yellow')
  if (status.state === 'error') {
    return paint(`· "${name}" failed to connect: ${stripControlChars(status.error ?? 'unknown error')}`, 'red')
  }
  const names = status.toolNames ?? []
  if (!names.length) return paint(`· "${name}" is connected but exposes no tools`, 'dim')
  const lines = [paint(`${name} — ${names.length} tool${names.length === 1 ? '' : 's'}:`, 'bold')]
  // Namespaced as the agent sees them, so what is listed here is what appears in
  // an approval prompt.
  for (const t of names) lines.push(`  ${paint(stripControlChars(t), 'cyan')}`)
  return lines.join('\n')
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

  const model = pickDefaultModel(provider)
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
   * Read a whole composer message: the raw-mode line editor, which supports
   * bracketed paste (a multi-line paste lands as ONE editable block instead of
   * submitting its first line and replaying the rest), multi-line editing, Ctrl-R
   * history search, and an $EDITOR hand-off. Resolves the message, or null on
   * end-of-input / an interrupt (which routes through `onInterrupt` first, so the
   * driver's discard-vs-exit double-tap still applies).
   *
   * Optional: off-TTY and in tests it's absent and the driver falls back to
   * `readLine` + ComposerBuffer, which reads one physical line at a time.
   */
  readComposer?: (prompt: string | (() => string)) => Promise<string | null>
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
   * Emit an attention signal: set the tab/window title, and — only when the user
   * has switched away — ring the bell and fire the terminal's notification. This
   * is what makes a long unattended run trustworthy: a session that blocks on an
   * approval used to sit silent, so the only way to notice was to keep looking.
   * Optional; absent off-TTY and in tests.
   */
  signal?: (sig: TerminalSignal) => void
  /**
   * Take (and clear) the messages typed while the agent was working, for dispatch
   * as the next turn. Absent off-TTY / in tests, where nothing is queued.
   */
  takeQueued?: () => string[]
  /** Drop anything queued (the run it followed was abandoned). */
  clearQueued?: () => void
  /**
   * Register a handler for Shift-Tab (cycle the approval mode). Fires at the
   * composer and mid-run alike; the driver decides what cycling means.
   */
  onCycleMode?: (handler: () => void) => void
  /**
   * Show the approval mode on the spinner line while a turn runs — the composer's
   * status line is gone exactly when it matters most.
   */
  setMode?: (label: string) => void
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
  /**
   * Deliver the user's verdict, plus any guidance they attached ("no, do X
   * instead"), which the loop hands to the model with the refusal.
   */
  resolveApproval: (
    runId: string,
    callId: string,
    decision: ToolApprovalDecision,
    note?: string
  ) => void
  resolveQuestion: (runId: string, callId: string, answer: string) => void
  /** Deliver the user's verdict on a `present_plan` review (accept / suggest / reject). */
  resolvePlan: (runId: string, callId: string, decision: PlanDecision) => void
  /** Deliver the user's answer to an MCP server's mid-call input request. */
  resolveElicitation: (runId: string, elicitId: string, result: ElicitationResult) => void
  cancelRun: (runId: string) => void
  /**
   * Change a RUNNING turn's approval policy. The core has always supported this
   * (the GUI switches mid-run); the terminal could only change the policy for the
   * next turn, so loosening it to get past a wall meant interrupting the work you
   * were trying to unblock.
   */
  setRunPolicy?: (runId: string, policy: ApprovalPolicy) => void
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
   * OAuth sign-in/out for remote MCP servers (the `/mcp login|logout <n>` verbs).
   * `login` runs the interactive browser flow for the server and persists the
   * minted tokens; `onStatus` receives user-facing progress lines (including the
   * authorize URL fallback). Absent ⇒ the verbs report sign-in as unavailable.
   */
  mcpOAuth?: {
    login: (server: McpServerConfig, onStatus: (message: string) => void) => Promise<void>
    logout: (serverId: string) => void
  }
  /** Live per-server connection status for `/mcp` (from the MCP manager). */
  mcpStatuses?: () => McpServerStatus[]
  /**
   * Whether this host persists secret VALUES (headers / stdio env) from settings
   * saves. False on the standalone CLI, whose store keeps only the keys — the
   * /mcp add flow then tells the user where the values actually go.
   */
  canStoreHeaderSecrets?: boolean
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
   * The image on the system clipboard, for a bare `/image`. The desktop app has
   * had this forever through Electron; the terminal shells out to whatever the
   * platform ships, since the whole vision path already works and only the bytes
   * were missing. Absent ⇒ the command says to use `/image <path>`.
   */
  clipboardImage?: () => { image: ImageAttachment } | { error: string }
  /**
   * Open `initial` text in the user's `$VISUAL`/`$EDITOR` and return the edited
   * result (null if no editor is configured or the edit was aborted). Used by the
   * plan-review "edit" action so the user can revise a plan in a real editor.
   */
  editText?: (initial: string) => Promise<string | null>
  /**
   * The running version, shown in the banner and by /doctor. A terminal user
   * otherwise has no way to tell which build they are on — which matters most
   * exactly when something is broken and they are reporting it.
   */
  version?: string
  /**
   * Run a command in the USER's shell for `!cmd` — unsandboxed, in the workspace,
   * with their environment. Streams output through `onOutput`; resolves the exit
   * code. Absent ⇒ `!` reports that the shell escape is unavailable.
   *
   * Deliberately NOT the agent's sandboxed shell. The sandbox confines the AGENT,
   * which may be prompt-injected; a command the user typed is their own intent —
   * they could run it in another window — and confining it would only surprise
   * them (`!git push` failing offline, `!npm i` unable to write).
   */
  runUserShell?: (command: string, onOutput: (chunk: string) => void) => Promise<number>
  /**
   * The background sessions the agent spawned from this chat (`spawn_session`),
   * so `/spawned` can list and open them. Absent ⇒ the command says fan-out
   * isn't available here.
   */
  backgroundSessions?: () => BackgroundSession[]
  /**
   * Probe the environment for /doctor (binaries, sandbox backend, MCP state).
   * Absent ⇒ the command reports that diagnostics are unavailable.
   */
  doctor?: () => Promise<DoctorFacts>
  /**
   * Look for a newer release, or null. Never awaited before the prompt: the
   * result is surfaced at the next composer draw, so a slow feed can't delay
   * startup and a write can't land in the middle of the composer's region.
   */
  checkUpdate?: () => Promise<{ latest: string; url: string; headline?: string } | null>
  /**
   * Optional syntax highlighter returning highlight.js token HTML for a fenced
   * code block, or null to render it plain. Kept as HTML (not ANSI) so the hljs
   * dependency stays at the entry point and the driver + its tests need no hljs.
   */
  highlightHtml?: (lang: string, code: string) => string | null
}

/**
 * A `!`-prefixed line: run it in the user's own shell, like the escape every
 * terminal REPL has (psql, gdb, python). Returns the command, or null when the
 * line isn't one.
 *
 * `!` alone is not a command, and neither is `! ` — those are a typo or the start
 * of a sentence, and running an empty shell is pointless.
 */
export function parseShellEscape(line: string): string | null {
  if (!line.startsWith('!')) return null
  const cmd = line.slice(1).trim()
  return cmd || null
}

/** How much `!cmd` output is handed to the model — enough to act on, not a flood. */
export const SHELL_ESCAPE_MAX_LINES = 200

/**
 * What the model is told about a command the user ran themselves.
 *
 * Written as a plain user turn because that is what it is: the user reporting
 * something they did. Without this the output would be on screen but invisible to
 * the agent, so "now fix those failures" would mean pasting it back — and pasting
 * it back is the thing the shell escape exists to avoid.
 */
export function renderShellEscapeRecord(command: string, output: string, exitCode: number): string {
  const lines = output.split('\n')
  const clipped = lines.length > SHELL_ESCAPE_MAX_LINES
  const body = (clipped ? lines.slice(-SHELL_ESCAPE_MAX_LINES) : lines).join('\n').trim()
  const head = `I ran this in my shell${exitCode === 0 ? '' : ` (it exited ${exitCode})`}:`
  const note = clipped ? `\n[earlier output trimmed; showing the last ${SHELL_ESCAPE_MAX_LINES} lines]` : ''
  return body
    ? `${head}\n\n$ ${command}${note}\n\n${body}`
    : `${head}\n\n$ ${command}\n\n(no output)`
}

/**
 * The next approval mode, in the order they appear in APPROVAL_POLICIES: plan →
 * ask → auto-edit → full-auto → plan.
 *
 * Ordered least-to-most permissive on purpose, so Shift-Tab reads as "loosen",
 * and the wrap lands back on the most restrictive rather than sliding past it.
 */
export function nextPolicy(current: ApprovalPolicy): ApprovalPolicy {
  const i = APPROVAL_POLICIES.indexOf(current)
  return APPROVAL_POLICIES[(i + 1) % APPROVAL_POLICIES.length]
}

/**
 * Whether the active model can reason at all: true / false from the host's
 * capability metadata, or null when it says nothing either way.
 *
 * Worth knowing before promising an effort setting will do something. Turning
 * thinking up on a model that cannot think is the kind of thing that looks like a
 * bug in Houston rather than a fact about the model.
 */
function activeModelReasons(deps: TuiDeps, providerId: string | null, model: string | null): boolean | null {
  if (!providerId || !model) return null
  const p = deps.getSettings().providers.find((x) => x.id === providerId)
  return p?.models.find((m) => m.id === model)?.caps?.reasoning ?? null
}

/** `/reasoning` with no argument: what it is now, and what it can be. */
export function renderReasoningStatus(
  current: ReasoningEffort,
  modelReasons: boolean | null,
  paint: Painter
): string {
  const lines = [
    `${paint('thinking effort:', 'bold')} ${paint(current, 'cyan')}`,
    paint(`  options: ${REASONING_EFFORTS.join(' | ')}   (usage: /reasoning <effort>)`, 'dim')
  ]
  if (modelReasons === false) {
    lines.push(paint('  the active model does not support reasoning, so this has no effect on it', 'yellow'))
  }
  return lines.join('\n')
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
/** Pluralized summary of a project's elevating config, e.g. "2 hooks, 1 MCP server". */
export function summarizeElevated(c: { allowRules: unknown[]; hooks: unknown[]; mcpServers: unknown[] }): string {
  return [
    c.allowRules.length ? `${c.allowRules.length} allow rule${c.allowRules.length === 1 ? '' : 's'}` : '',
    c.hooks.length ? `${c.hooks.length} hook${c.hooks.length === 1 ? '' : 's'}` : '',
    c.mcpServers.length ? `${c.mcpServers.length} MCP server${c.mcpServers.length === 1 ? '' : 's'}` : ''
  ]
    .filter(Boolean)
    .join(', ')
}

/**
 * The terminal counterpart of the desktop's trusted-folders banner: if the
 * workspace's `.houston/settings.json` elevates (allow rules, hooks, MCP
 * servers) and the folder is undecided — or its elevating config changed since
 * it was trusted — ask before the session starts. `y` trusts (bound to the
 * current config fingerprint), `never` persistently refuses, anything else
 * leaves it off and asks again next session. No-op when nothing elevates, the
 * decision already stands, or this host can't persist settings.
 */
export async function promptFolderTrust(cwd: string, deps: TuiDeps, paint: Painter): Promise<void> {
  if (!deps.updateSettings) return
  const cfg = await loadProjectConfig(cwd)
  if (!cfg.elevatedHash) return
  let path = cwd
  try {
    path = realpathSync(cwd)
  } catch {
    // Keep the raw path; the loop normalizes the same way, so they still match.
  }
  const settings = deps.getSettings()
  const state = folderTrustState(settings.trustedFolders, path, cfg.elevatedHash)
  if (state === 'trusted' || state === 'untrusted') return

  deps.io.out(
    `\n${paint(state === 'changed' ? 'This project’s trusted configuration changed.' : 'This project asks for extra permissions.', 'cyan')}\n` +
      `  Its .houston/settings.json defines ${summarizeElevated(cfg.elevated)}.\n` +
      paint(
        '  Hooks and MCP servers run as you, and allow rules auto-approve matching actions.\n' +
          '  Only trust folders whose authors you trust; until then Houston ignores them.\n',
        'dim'
      )
  )
  const answer = (await deps.io.readLine('Trust this folder? [y/N/never] ', { discardPending: true }))?.trim().toLowerCase()
  const decision = answer === 'y' || answer === 'yes' ? 'trusted' : answer === 'never' ? 'never' : null
  if (!decision) {
    deps.io.out(paint('· leaving the extra permissions off (will ask again next session)\n', 'dim'))
    return
  }
  deps.updateSettings({
    trustedFolders: upsertFolderTrust(settings.trustedFolders, {
      path,
      decision,
      hash: cfg.elevatedHash,
      decidedAt: Date.now()
    })
  })
  deps.io.out(
    paint(
      decision === 'trusted'
        ? '· folder trusted: its allow rules, hooks, and MCP servers now apply\n'
        : '· never trusting this folder: its extra permissions stay off\n',
      'dim'
    )
  )
}

export async function runTui(opts: TuiOptions, deps: TuiDeps): Promise<number> {
  // Reassigned by /theme (takes effect from the next output); the spinner keeps
  // the initial theme since its painter lives in the terminal adapter.
  const settings = deps.getSettings()
  // Reassigned by /theme (takes effect from the next output); the spinner keeps the
  // initial theme since its painter lives in the terminal adapter.
  let paint = makePainter(opts.color, resolveTheme(settings.tuiTheme ?? '') ?? 'default')
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
      if (parseApprovalAnswer(answer ?? '').decision !== 'allow') {
        deps.io.out('Terms not accepted. Exiting.\n')
        return 2
      }
    }
    deps.recordLegalAcceptance()
    deps.io.out(paint('· Houston terms accepted (recorded for future runs)\n', 'dim'))
  }

  // Trusted-folders gate: if this project's .houston/settings.json ELEVATES
  // (allow rules / hooks / MCP servers) and the folder is undecided (or its
  // elevating config changed since it was trusted), ask now — this is the
  // terminal counterpart of the desktop's trust banner. Declining just leaves
  // the elevation off; the session proceeds either way.
  await promptFolderTrust(opts.cwd, deps, paint)

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
  // The provider/model last written to the backing conversation's meta. `create`
  // stores them once; after that a `/model` switch or a `/resume` onto a chat made
  // under a different model leaves the stored value stale (see setModel). We track
  // what we've persisted and, when a turn runs under a different model, rewrite it —
  // mirroring the GUI, which calls updateConversationMeta on every send. null means
  // "unknown" (freshly resumed/forked), which forces the next turn to re-sync.
  let persistedProviderId: string | null = null
  let persistedModel: string | null = null
  const syncPersistedModel = (): void => {
    if (!deps.persist || !conversationId || !providerId || !model) return
    if (persistedProviderId === providerId && persistedModel === model) return
    try {
      deps.persist.setModel(conversationId, providerId, model)
      persistedProviderId = providerId
      persistedModel = model
    } catch (e) {
      if (!warnedPersistFail) {
        warnedPersistFail = true
        deps.io.out(paint(`· couldn't save the conversation (continuing unsaved): ${(e as Error).message}\n`, 'dim'))
      }
    }
  }
  // Short project label, folded into titles/notifications so two terminals in two
  // projects are tellable apart at a glance.
  const workspaceName = workspaceLabel(opts.cwd)
  // Read once: the terminal tells users settings apply on restart, and re-reading
  // per event would cost a settings load on every streamed token.
  const notifyEnabled = settings.desktopNotifications !== false
  // Show each tool's full output as it runs (/verbose). Off by default: the
  // transcript is a conversation, and most results are noise until they aren't.
  let verbose = false
  // Follow-ups typed while the agent was working, dispatched as the next turn.
  let pendingQueued: string[] = []
  const sessionCost: SessionCost = { inputTokens: 0, outputTokens: 0, cost: 0 }
  // Image attachments staged via /image, attached to (and cleared by) the next turn.
  let pendingImages: ImageAttachment[] = []
  // Estimated current context size (last turn's input tokens), for the status line.
  let contextTokens = 0
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
  // True only while reading the composer, so a Ctrl-C at a between-turn sub-prompt
  // (/resume, /login, plan handoff) is handled as a plain cancel, not a composer
  // reset/exit whose flag would leak into the next composer read.
  let atComposer = false
  deps.io.onInterrupt?.(() => {
    if (activeRunId) {
      deps.cancelRun(activeRunId)
      deps.io.stopSpinner?.()
      // Whatever was queued was a follow-up to the turn being thrown away; sending
      // it into the wreckage would be worse than dropping it.
      deps.io.clearQueued?.()
      // Show that the interrupt registered — otherwise an aborted turn just stops
      // with no feedback — then release any approval/question prompt blocked on
      // input so the aborted run doesn't leave the loop waiting on a dead read.
      deps.io.out(paint('\n^C interrupted\n', 'dim'))
      deps.io.cancelRead?.()
      return
    }
    // A between-turn sub-prompt (the /resume picker, /login, plan handoff, …) also
    // reads with no active run. Ctrl-C there should just cancel that read, NOT set
    // the composer reset/exit flag (which the sub-prompt never consumes — it would
    // leak into the next composer read and swallow a later Ctrl-D) or advance the
    // double-tap timer.
    if (!atComposer) {
      deps.io.cancelRead?.()
      return
    }
    // No run, at the composer → discard whatever's typed and re-prompt; a second
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

  // Kick the update check off now, but never await it: the answer is printed at
  // the next composer draw (see updateNotice), where a write is safe.
  let updateNotice: string | null = null
  if (deps.checkUpdate) {
    void deps.checkUpdate()
      .then((u) => {
        if (!u) return
        const head = u.headline ? ` — ${u.headline}` : ''
        updateNotice =
          paint(`· update available: ${u.latest} (you have ${deps.version ?? 'this build'})${head}`, 'yellow') +
          paint(`\n  ${u.url}`, 'dim')
      })
      .catch(() => {
        /* a failed update check is a non-event */
      })
  }

  deps.io.signal?.({ title: idleTitle(workspaceName) })
  // --continue / --resume: open the chat before the first prompt, so picking up
  // where you left off is the launch itself rather than a step after it.
  if ((opts.continueSession || opts.resumeId) && deps.persist) {
    const wanted = opts.resumeId
    let entry: ResumeEntry | undefined
    try {
      entry = wanted
        ? deps.persist.list(opts.cwd).find((c) => c.id === wanted)
        : deps.persist.list(opts.cwd)[0]
    } catch {
      entry = undefined
    }
    // An explicit --resume <id> that isn't there is a mistake worth naming; a
    // --continue with nothing to continue is just a fresh start.
    const conv = entry ? deps.persist.get(entry.id) : null
    if (conv) {
      conversationId = entry!.id
      messages = conv.messages
      persistedProviderId = persistedModel = null
      deps.io.out(
        paint(`· continuing "${entry!.title}" (${messages.length} message(s))\n`, 'dim')
      )
    } else if (wanted) {
      deps.io.out(paint(`· no saved session "${wanted}" in this folder; starting fresh\n`, 'yellow'))
    } else {
      deps.io.out(paint('· no saved session in this folder yet; starting fresh\n', 'dim'))
    }
  }

  // Shift-Tab, at the composer or mid-run. Mid-run it also retargets the live run,
  // so you can loosen the mode to get past an approval without killing the turn.
  deps.io.setMode?.(policy)
  deps.io.onCycleMode?.(() => {
    policy = nextPolicy(policy)
    deps.io.setMode?.(policy)
    if (activeRunId) {
      deps.setRunPolicy?.(activeRunId, policy)
      deps.io.out(paint(`\n· approval → ${policy} (this run too)\n`, 'dim'))
    }
  })

  deps.io.out(
    `${paint('Houston', 'bold', 'cyan')} ${paint(deps.version ? `v${deps.version}` : '', 'dim')} ${paint('(interactive)', 'dim')}\n` +
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
    // The update check resolves whenever it resolves; print it HERE, between turns,
    // where nothing else owns the screen. Writing it from the promise would land in
    // the middle of the composer's redraw region (or a streaming turn) and corrupt it.
    if (updateNotice) {
      deps.io.out(`${updateNotice}\n`)
      updateNotice = null // one nudge per session, not per prompt
    }
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
          : renderNoModelStatus(policy, opts.cwd, columns(), paint)
      }\n`
    )
    // Read a message. On a real terminal this is the raw-mode editor, which takes a
    // pasted block whole (bracketed paste) and edits multi-line drafts in place.
    // Without one (tests, a pipe) it falls back to reading physical lines, where a
    // trailing backslash or an open code fence continues onto the next line.
    let raw: string | null = null
    let resetComposer = false
    atComposer = true // Ctrl-C now means "clear/exit the composer" (see onInterrupt)
    // Ctrl-C settles either read: 'reset' discards this entry and re-prompts, 'exit'
    // (a second Ctrl-C) leaves like Ctrl-D; otherwise a null is a real EOF.
    const consumeInterrupt = (): 'reset' | 'exit' | null => {
      const flag = composerInterrupt
      composerInterrupt = null
      return flag
    }
    if (pendingQueued.length) {
      // Typed while the last turn ran. Dispatch it instead of prompting: waiting for
      // an Enter they already pressed would be the exact tax queueing removes.
      raw = pendingQueued.join('\n\n')
      pendingQueued = []
      deps.io.out(`${composerPrompt(policy, paint)}${raw}\n`)
    } else if (deps.io.readComposer) {
      // A thunk, not a string: Shift-Tab can change the policy WHILE this read is
      // open, and the prompt has to say what will actually happen when you hit Enter.
      const text = await deps.io.readComposer(() => composerPrompt(policy, paint))
      if (text === null) {
        resetComposer = consumeInterrupt() === 'reset'
      } else {
        raw = text
      }
    } else {
      const composer = new ComposerBuffer()
      for (;;) {
        // In an open code fence, hint how to send so a stray ``` can't trap the
        // composer with no visible way out (typing the closing ``` submits).
        const p = composer.pending
          ? paint(composer.inFence ? '… (``` to close and send) ' : '… ', 'dim')
          : composerPrompt(policy, paint)
        const line = await deps.io.readLine(p)
        if (line === null) {
          const flag = consumeInterrupt()
          if (flag === 'reset') {
            resetComposer = true
            break
          }
          if (flag === 'exit') break // raw stays null → exit below
          if (composer.pending) raw = composer.flush() // EOF mid-entry → submit what we have
          break
        }
        const done = composer.push(line)
        if (done !== null) {
          raw = done
          break
        }
      }
    }
    atComposer = false // sub-prompts below are not the composer
    if (resetComposer) continue // Ctrl-C discarded the input — draw a fresh prompt
    if (raw === null) break // clean Ctrl-D (or a second Ctrl-C) at the composer → exit
    let text = raw.trim()
    if (!text) continue
    // Persist composer submissions (commands included) for cross-restart recall;
    // approval/question answers go through a different read and aren't saved.
    deps.persistHistory?.(text)

    // `!cmd` — the user's own shell, checked before slash commands so a `!` line is
    // never mistaken for prompt text. Between turns, so writing output is safe.
    const shellCmd = parseShellEscape(text)
    if (shellCmd !== null) {
      if (!deps.runUserShell) {
        deps.io.out(paint('· the shell escape (!) is unavailable here\n', 'dim'))
        continue
      }
      deps.io.out(paint(`$ ${shellCmd}\n`, 'dim'))
      let captured = ''
      let code: number
      try {
        code = await deps.runUserShell(shellCmd, (chunk) => {
          // Stream it: a build or a test run should look alive, not hung.
          deps.io.out(chunk)
          captured += chunk
        })
      } catch (e) {
        deps.io.out(paint(`· couldn't run it: ${(e as Error).message}\n`, 'yellow'))
        continue
      }
      if (code !== 0) deps.io.out(paint(`· exited ${code}\n`, 'yellow'))
      // Record it in the conversation, so "now fix those failures" works without
      // pasting the output back in — the whole reason to run it HERE rather than in
      // another window. Capped: a chatty command must not eat the context window.
      messages.push({ role: 'user', content: renderShellEscapeRecord(shellCmd, captured, code) })
      persistMessages(messages)
      continue
    }

    if (text.startsWith('/')) {
      const result = parseSlashCommand(text, deps.getSettings(), templateCommands)
      if (result.kind === 'exit') break
      if (result.kind === 'clear') {
        messages = []
        conversationId = null // next turn starts (and persists) a fresh conversation
        persistedProviderId = persistedModel = null // stored meta belongs to the old conversation
        pendingImages = [] // don't carry a staged /image into the fresh conversation
        contextTokens = 0 // the context meter belongs to the old conversation
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
        // The resumed chat's stored model is unknown to the driver; mark the meta
        // stale so the first turn re-syncs it to the model actually in use (which may
        // differ from the one it was created under).
        persistedProviderId = persistedModel = null
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
        // The fork is a fresh conversation whose stored model we don't track; mark it
        // stale so the next turn re-syncs the meta to the active model.
        persistedProviderId = persistedModel = null
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
      if (result.kind === 'verbose') {
        verbose = result.on ?? !verbose
        deps.io.out(
          paint(
            verbose
              ? '· verbose: showing each tool\'s output as it runs (/output reprints one in full)\n'
              : '· verbose off: tool output collapses to one line again\n',
            'dim'
          )
        )
        continue
      }
      if (result.kind === 'spawned') {
        if (!deps.backgroundSessions) {
          deps.io.out(paint('· background sessions are unavailable here\n', 'dim'))
          continue
        }
        const list = deps.backgroundSessions()
        deps.io.out(`${renderBackgroundSessions(list, nowFn(), paint)}\n`)
        if (!list.length) continue
        const ans = await deps.io.readLine('> ', { discardPending: true })
        const id = ans === null ? null : parseSessionSelection(ans, list)
        if (!id) {
          deps.io.out(paint('· cancelled\n', 'dim'))
          continue
        }
        if (!deps.persist) {
          deps.io.out(paint('· opening a session needs a session store\n', 'dim'))
          continue
        }
        let conv: { messages: ChatMessage[] } | null
        try {
          conv = deps.persist.get(id)
        } catch (e) {
          deps.io.out(paint(`· couldn't open that session: ${(e as Error).message}\n`, 'dim'))
          continue
        }
        if (!conv) {
          deps.io.out(paint('· that session could not be opened\n', 'dim'))
          continue
        }
        // Opening a still-running session is deliberately allowed: you see its work
        // so far while its own run keeps going and keeps persisting. That is how you
        // check on parallel work without stopping it.
        const stillRunning = list.find((x) => x.id === id)?.running
        conversationId = id
        messages = conv.messages
        persistedProviderId = persistedModel = null
        deps.io.out(
          paint(
            stillRunning
              ? `· opened a running session (${messages.length} message(s) so far); it keeps going in the background\n`
              : `· opened: ${messages.length} message(s)\n`,
            'dim'
          )
        )
        continue
      }
      if (result.kind === 'output') {
        deps.io.out(`${renderRecoveredOutput(toolResultsFrom(messages), result.index, paint)}\n`)
        continue
      }
      if (result.kind === 'reasoning') {
        const current = deps.getSettings().reasoningEffort ?? 'off'
        if (!result.effort) {
          deps.io.out(`${renderReasoningStatus(current, activeModelReasons(deps, providerId, model), paint)}\n`)
          continue
        }
        if (!deps.updateSettings) {
          deps.io.out(paint('· changing settings is unavailable here\n', 'dim'))
          continue
        }
        deps.updateSettings({ reasoningEffort: result.effort })
        deps.io.out(paint(`· thinking effort → ${result.effort}\n`, 'dim'))
        // Say it plainly rather than let someone wonder why nothing changed.
        if (result.effort !== 'off' && activeModelReasons(deps, providerId, model) === false) {
          deps.io.out(
            paint(`· note: ${model} does not support reasoning, so this has no effect on it\n`, 'yellow')
          )
        }
        continue
      }
      if (result.kind === 'doctor') {
        if (!deps.doctor) {
          deps.io.out(paint('· diagnostics are unavailable here\n', 'dim'))
          continue
        }
        deps.io.out(paint('· checking…\n', 'dim'))
        try {
          const facts = await deps.doctor()
          deps.io.out(`${renderDoctor(buildDoctorReport(facts), paint)}\n`)
        } catch (e) {
          deps.io.out(paint(`· couldn't run diagnostics: ${(e as Error).message}\n`, 'yellow'))
        }
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
      if (result.kind === 'paste-image') {
        if (!deps.clipboardImage) {
          deps.io.out(paint('· pasting images is unavailable here; use /image <path>\n', 'dim'))
          continue
        }
        if (pendingImages.length >= 8) {
          deps.io.out(paint('· already have 8 images staged (the max)\n', 'yellow'))
          continue
        }
        const img = deps.clipboardImage()
        if ('error' in img) {
          deps.io.out(paint(`· ${img.error}\n`, 'dim'))
          continue
        }
        pendingImages.push(img.image)
        deps.io.out(paint(`· attached the image from your clipboard (${pendingImages.length} staged)\n`, 'dim'))
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
        deps.io.setMode?.(policy)
        deps.io.out(paint(`· approval policy → ${policy}\n`, 'dim'))
        continue
      }
      if (result.kind === 'set-model') {
        providerId = result.providerId
        model = result.model
        // Persist the switch as the saved selection, mirroring the GUI's picker —
        // otherwise the next launch snaps back to whatever `selected` was stored
        // last (usually by a long-ago /login) and the switch silently evaporates.
        deps.updateSettings?.({ selected: { providerId, model } })
        deps.io.out(paint(`· model → ${providerId} / ${model}\n`, 'dim'))
        continue
      }
      if (result.kind === 'set-theme') {
        paint = makePainter(opts.color, result.theme)
        // Persist it: a theme you have to re-pick on every launch is not a setting,
        // it is a party trick.
        deps.updateSettings?.({ tuiTheme: result.theme })
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
        // create() stored these, so the meta already matches — no sync needed below.
        persistedProviderId = providerId
        persistedModel = model
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
    // Keep the stored provider/model in step with the model this turn actually runs
    // under (after a `/model` switch or a `/resume`) — same ordering as the GUI, which
    // follows setMessages with updateConversationMeta on every send.
    syncPersistedModel()
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

    const send = (e: AgentEvent): void => {
      // Attention signals ride the event stream itself, so anything that blocks the
      // run (approval, question, plan) or ends it can pull the user back. Done once,
      // here, rather than at each case: a signal added to the policy then reaches the
      // terminal without touching the renderer below.
      const sig = signalFor(e, workspaceName)
      // The title is ambient (it just describes the tab) so it is always set; the
      // bell + notification honor the user's existing "notify me" setting.
      if (sig) deps.io.signal?.(notifyEnabled ? sig : sig.title ? { title: sig.title } : {})
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
          const line = renderToolResult(e.name, e.ok, e.output, paint, { verbose })
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
        case 'model_fallback':
          deps.io.setSpinnerLabel?.('Switching model')
          deps.io.out(paint(`\n· ${e.from} unavailable, falling back to ${e.to}… ${e.reason}\n`, 'yellow'))
          break
        case 'tool_approval':
          enqueue(async () => {
            // Context (name, kind, unsandboxed warning) + the diff for a write.
            deps.io.out(`${renderApprovalPrompt(e, paint)}\n`)
            if (e.kind === 'write') {
              // Prefer the main process's preview: it is diffed against the files'
              // actual contents, so an overwrite shows what changed rather than the
              // whole file, and a multi_edit has a diff at all. Fall back to deriving
              // one from the args (`tool_start` is emitted only AFTER approval
              // resolves, so `toolArgs` is still empty here for a write).
              // The preview is diffed against the files' real contents and already
              // folded to the change; render it with numbers + word marks. Only fall
              // back to deriving a diff from the args when there is no preview.
              const view =
                (e.preview ? renderPreviewView(e.preview, paint, deps.highlightHtml ? highlight : undefined) : null) ??
                (() => {
                  const raw = extractDiff(e.args ?? toolArgs.get(e.callId) ?? {})
                  return raw ? colorizeDiff(raw, paint) : null
                })()
              if (view) deps.io.out(`${view}\n`)
            }
            let decision: ToolApprovalDecision | null = null
            let note: string | undefined
            if (deps.io.select) {
              // The shell-network consent is a yes/no question about egress, not a
              // permission rule about a command — offering "always allow"/"deny with a
              // reason" there would be nonsense, so keep that prompt to three options.
              const r = await deps.io.select({
                title: 'Choose:',
                options: e.shellNetwork
                  ? [
                      { label: 'Allow network', value: 'allow' },
                      { label: 'No network', value: 'deny' },
                      { label: 'Allow for run', value: 'always' }
                    ]
                  : APPROVAL_OPTIONS.map((o) => ({
                      label: o.label,
                      value: o.value,
                      description: o.description
                    }))
              })
              if (r.kind === 'commit') {
                if (r.value === 'deny-note') {
                  // Collect the guidance in the same interaction as the refusal.
                  const typed = await deps.io.readLine('Why not? (what should it do instead) ', {
                    discardPending: true
                  })
                  decision = 'deny'
                  note = typed?.trim() || undefined
                } else {
                  decision = r.value as ToolApprovalDecision
                }
              } else if (r.kind === 'cancel') decision = 'deny' // safe default
              // 'type' → fall through to the typed prompt below
            }
            if (decision === null) {
              const ans = await deps.io.readLine('> ', { discardPending: true })
              const parsed = parseApprovalAnswer(ans ?? '')
              decision = parsed.decision
              note = parsed.note
            }
            deps.resolveApproval(e.runId, e.callId, decision, note)
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
        case 'elicitation':
          // An MCP server asked for input mid-tool-call. Show who is asking (the
          // values go to that external server), offer a decline, then collect one
          // line per field, re-prompting on invalid values.
          enqueue(async () => {
            deps.io.out(
              `\n${paint(`MCP server "${e.serverId}" requests input:`, 'cyan')} ${e.message}\n`
            )
            const proceed = await deps.io.readLine('Provide it? [y/N] ', { discardPending: true })
            if (proceed === null || !/^y(es)?$/i.test(proceed.trim())) {
              deps.resolveElicitation(e.runId, e.elicitId, {
                action: proceed === null ? 'cancel' : 'decline'
              })
              deps.io.out(paint('· declined\n', 'dim'))
              return
            }
            const raw: Record<string, string> = {}
            for (const f of e.fields) {
              if (f.description) deps.io.out(paint(`  ${f.name}: ${f.description}\n`, 'dim'))
              for (;;) {
                const hints = [
                  f.kind === 'enum' ? (f.options ?? []).join(' | ') : f.kind !== 'string' ? f.kind : '',
                  f.required ? 'required' : 'optional'
                ]
                  .filter(Boolean)
                  .join('; ')
                const ans = await deps.io.readLine(`${f.title ?? f.name}${hints ? ` (${hints})` : ''}: `, {
                  discardPending: true
                })
                if (ans === null) {
                  deps.resolveElicitation(e.runId, e.elicitId, { action: 'cancel' })
                  deps.io.out(paint('· cancelled\n', 'dim'))
                  return
                }
                const check = buildElicitationContent([f], { [f.name]: ans })
                if ('content' in check) {
                  raw[f.name] = ans
                  break
                }
                deps.io.out(paint(`· ${check.error}\n`, 'yellow'))
              }
            }
            const built = buildElicitationContent(e.fields, raw)
            if ('error' in built) {
              // Per-field checks passed, so this is unreachable in practice; keep
              // the safe fallback anyway.
              deps.resolveElicitation(e.runId, e.elicitId, { action: 'decline' })
              return
            }
            deps.resolveElicitation(e.runId, e.elicitId, { action: 'accept', content: built.content })
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
        case 'notice':
          // A user-addressed note (a hook's systemMessage) — display-only, never
          // part of the model's context.
          deps.io.out(paint(`\n· ${e.message}\n`, 'dim'))
          break
        case 'done':
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
            if (decision.kind === 'accept') {
              policy = decision.mode
              deps.io.setMode?.(policy)
            }
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
    // Anything typed while that turn ran becomes the next one.
    pendingQueued = deps.io.takeQueued?.() ?? []

    // A plan-mode turn hands off to execution through the present_plan flow: the agent
    // calls present_plan, the plan_ready case above renders it and collects an
    // accept / suggest / reject verdict, and accepting flips the policy to auto-edit
    // (or ask) and carries the plan out. There is deliberately no text-only fallback:
    // treating any plain assistant answer as a "plan" spuriously offered to leave plan
    // mode after ordinary questions.
  }

  // Hand the tab back with no title of ours; the shell sets its own at the next
  // prompt, and a lingering "Houston · proj" would be a lie once we're gone.
  deps.io.signal?.({ title: '' })
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
  const parts = line.slice(1).trim().split(/\s+/)
  const name = nameOf(parts[0])
  const arg = parts.slice(1).join(' ') // present only when the user passed an (invalid) arg
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
    // A present-but-unrecognized arg reached here (a valid one would have set the
    // theme); say so instead of silently just re-listing.
    if (arg) deps.io.out(paint(`· unknown theme: ${arg}\n`, 'yellow'))
    deps.io.out(paint(`themes: ${Object.keys(THEMES).join(', ')}  (usage: /theme <name>)\n`, 'dim'))
    return
  }
  if (name === 'image') {
    // Bare /image (no path) used to be a silent no-op; show how to use it.
    deps.io.out(paint('usage: /image <path>  (attach an image to your next message)\n', 'dim'))
    return
  }
  if (name === 'approval') {
    if (arg) deps.io.out(paint(`· unknown policy: ${arg}\n`, 'yellow'))
    deps.io.out(
      paint(`approval: ${state.policy}  (plan | ask | auto-edit | full-auto)\n`, 'dim')
    )
    return
  }
  if (name === 'model' || name === 'model?') {
    const settings = deps.getSettings()
    // A present arg reached here only because it didn't resolve to a known model.
    if (arg && name === 'model') deps.io.out(paint(`· unknown model: ${arg}\n`, 'yellow'))
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
    `    ${paint('/mcp', 'cyan')}     list, or  /mcp add (stdio)  ·  /mcp remove <n>  ·  /mcp login|logout <n>`,
    '',
    paint('  Changes are picked up on restart.', 'dim')
  ]
  deps.io.out(`${lines.join('\n')}\n`)
}

/** /hooks: list, add (guided), or remove a lifecycle hook. Persists via deps.updateSettings. */
async function runHooksCommand(action: SettingsAction, deps: TuiDeps, paint: Painter): Promise<void> {
  const hooks = deps.getSettings().hooks ?? []
  const path = deps.settingsPath?.() ?? '(unknown)'

  if (
    action.op === 'usage' ||
    action.op === 'login' ||
    action.op === 'logout' ||
    action.op === 'tools'
  ) {
    // login/logout/tools are /mcp verbs; on /hooks they just fall to usage.
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
  if (parseApprovalAnswer(ok ?? '').decision !== 'allow')
    return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings({ hooks: [...hooks, built] })
  deps.io.out(paint('· hook added. Applies on restart.\n', 'dim'))
}

/**
 * /mcp: list (with live connection status), add (guided, stdio only), remove, or
 * OAuth sign-in/out for a remote server. Persists via deps.updateSettings. The
 * add flow never collects a URL or auth headers; remote servers are added in the
 * desktop app and authenticated here with `/mcp login <n>`.
 */
async function runMcpCommand(action: SettingsAction, deps: TuiDeps, paint: Painter): Promise<void> {
  const servers = deps.getSettings().mcpServers ?? []
  const path = deps.settingsPath?.() ?? '(unknown)'

  if (action.op === 'usage') {
    deps.io.out(
      paint(
        'usage: /mcp   ·   /mcp add   ·   /mcp tools <n>   ·   /mcp remove <n>   ·   /mcp login <n>   ·   /mcp logout <n>\n',
        'yellow'
      )
    )
    return
  }
  if (action.op === 'list') {
    deps.io.out(`${renderMcpList(servers, paint, deps.mcpStatuses?.() ?? [])}\n${renderSettingsFooter(path, paint)}\n`)
    deps.io.out(
      paint('Remote (URL) servers: add them in the desktop app, then sign in with /mcp login <n> if needed.\n', 'dim')
    )
    return
  }

  if (action.op === 'tools') {
    const server = servers[action.index - 1]
    if (!server) {
      deps.io.out(
        paint(
          `· no MCP server #${action.index} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`,
          'yellow'
        )
      )
      return
    }
    const st = (deps.mcpStatuses?.() ?? []).find((x) => x.id === server.id)
    deps.io.out(`${renderMcpTools(server.name ?? server.id, st, paint)}\n`)
    return
  }

  if (action.op === 'login' || action.op === 'logout') {
    const server = servers[action.index - 1]
    if (!server) {
      deps.io.out(paint(`· no MCP server #${action.index} (there ${servers.length === 1 ? 'is 1' : `are ${servers.length}`})\n`, 'yellow'))
      return
    }
    const transport = server.transport ?? (server.url && !server.command ? 'http' : 'stdio')
    if (transport === 'stdio' || !server.url) {
      deps.io.out(paint(`· "${server.name ?? server.id}" is a local stdio server; OAuth sign-in applies to remote (http/sse) servers\n`, 'yellow'))
      return
    }
    if (!deps.mcpOAuth) {
      deps.io.out(paint('· OAuth sign-in is unavailable in this client\n', 'dim'))
      return
    }
    if (action.op === 'logout') {
      if (!server.hasOAuth) {
        deps.io.out(paint(`· "${server.name ?? server.id}" has no stored sign-in\n`, 'dim'))
        return
      }
      deps.mcpOAuth.logout(server.id)
      deps.io.out(paint(`· signed out of "${server.name ?? server.id}". Applies on your next message.\n`, 'dim'))
      return
    }
    try {
      await deps.mcpOAuth.login(server, (message) => deps.io.out(paint(`· ${message}\n`, 'dim')))
      deps.io.out(paint(`· signed in to "${server.name ?? server.id}". Applies on your next message.\n`, 'green'))
    } catch (e) {
      deps.io.out(paint(`· sign-in failed: ${(e as Error).message}\n`, 'yellow'))
    }
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
  deps.io.out(paint('Add a local (stdio) MCP server. For remote servers, use the desktop app (then /mcp login here if needed).\n', 'dim'))
  const nameAns = await deps.io.readLine('name (letters, numbers, - or _): ')
  if (nameAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cmdAns = await deps.io.readLine('command to spawn (e.g. npx): ')
  if (cmdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const argsAns = await deps.io.readLine('args (space-separated, optional): ')
  if (argsAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const cwdAns = await deps.io.readLine('working directory (optional): ')
  if (cwdAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))
  const envAns = await deps.io.readLine('env (KEY=value pairs, space-separated, optional): ')
  if (envAns === null) return void deps.io.out(paint('· cancelled\n', 'dim'))

  const built = buildStdioMcpServer(servers.map((s) => s.id), nameAns, cmdAns, argsAns, cwdAns, envAns)
  if ('error' in built) return void deps.io.out(paint(`· ${built.error}\n`, 'yellow'))

  const envNote = built.env ? `  env: ${Object.keys(built.env).join(', ')}` : ''
  deps.io.out(
    `\n${paint('server:', 'dim')} ${built.name}  [stdio]  ${built.command}${built.args?.length ? ` ${built.args.join(' ')}` : ''}${built.cwd ? `  (cwd: ${built.cwd})` : ''}${envNote}\n`
  )
  const ok = await deps.io.readLine('Add this server? [y/N] ', { discardPending: true })
  if (parseApprovalAnswer(ok ?? '').decision !== 'allow')
    return void deps.io.out(paint('· not added\n', 'dim'))
  deps.updateSettings({ mcpServers: [...servers, built] })
  deps.io.out(paint('· MCP server added. Applies on restart.\n', 'dim'))
  if (built.env && deps.canStoreHeaderSecrets === false) {
    deps.io.out(
      paint(
        `· this terminal cannot store env values; put them in cli-headers.json under the scope "mcp-env:${built.id}"\n`,
        'yellow'
      )
    )
  }
}
