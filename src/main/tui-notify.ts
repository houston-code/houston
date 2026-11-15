import type { AgentEvent } from '@shared/agent'
import { notificationFor, type NotifySpec } from '@shared/notify'
import type { AppSettings } from '@shared/types'
import { stripControlChars } from './tui-wrap'

/**
 * Attention signals for the terminal: the bell, the window/tab title, and the
 * terminal's own notification channel.
 *
 * The gap this closes: a terminal session that blocked on an approval said
 * NOTHING. You start a long run, switch away, and it sits there waiting for a
 * keypress you don't know it wants — the run is stalled and the only way to find
 * out is to keep checking. The desktop app has pinged for this since forever
 * (main/notifications.ts); the terminal had no equivalent, which is what made
 * long autonomous runs untrustworthy from a terminal.
 *
 * Everything here is pure string-building, so what gets written is unit-testable.
 * The escapes:
 *
 * - BEL (`\x07`) — the universal "look at me". Terminals decide what it means
 *   (flash, badge the tab, bounce the dock); we don't second-guess them.
 * - OSC 0 — set window + tab title. Not interruptive, so it is always on: the
 *   title IS the ambient status, visible without switching to the tab.
 * - OSC 9 — a real notification (iTerm2, Windows Terminal, WezTerm, kitty).
 * - OSC 777 — the same for VTE-based terminals (GNOME Terminal, Tilix) and urxvt.
 *
 * Both notification forms are emitted: a terminal ignores the one it doesn't
 * know, which costs nothing, and no single sequence covers the field.
 */

const BEL = '\x07'
const ESC = '\x1b'

/**
 * Which attention signals fire (/notify): `auto` both the bell and the terminal's
 * notification, `osc` the notification only, `bell` the bell only, `off` neither.
 * The title is ambient and set in every mode.
 */
export type NotifyMode = 'auto' | 'osc' | 'bell' | 'off'
export const NOTIFY_MODES: readonly NotifyMode[] = ['auto', 'osc', 'bell', 'off']

export function isNotifyMode(v: unknown): v is NotifyMode {
  return typeof v === 'string' && (NOTIFY_MODES as readonly string[]).includes(v)
}

/**
 * The session's mode: the terminal's own setting when there is one; otherwise the
 * shared "notify me" switch, so turning notifications off in the desktop app still
 * silences the terminal as it always has.
 */
export function resolveNotifyMode(settings: Pick<AppSettings, 'tuiNotify' | 'desktopNotifications'>): NotifyMode {
  if (isNotifyMode(settings.tuiNotify)) return settings.tuiNotify
  return settings.desktopNotifications === false ? 'off' : 'auto'
}

/** What each mode does, for /notify and /settings. */
export function describeNotifyMode(mode: NotifyMode): string {
  switch (mode) {
    case 'auto':
      return 'bell and terminal notification'
    case 'osc':
      return 'terminal notification only, no bell'
    case 'bell':
      return 'bell only'
    case 'off':
      return 'off, no bell or notification (the window title still updates)'
  }
}

/** What to write to the terminal for one event. */
export interface TerminalSignal {
  /** Ambient tab/window title (always safe to set). */
  title?: string
  /** Ring the bell + fire a notification (only when the user is away). */
  alert?: NotifySpec
  /** Which of the two the alert uses. Absent = both (`auto`). */
  mode?: Exclude<NotifyMode, 'off'>
}

/** The bytes an alert writes in a given mode. */
export function alertSequence(spec: NotifySpec, mode: NotifyMode = 'auto'): string {
  switch (mode) {
    case 'auto':
      return bellSequence() + notifySequence(spec)
    case 'osc':
      return notifySequence(spec)
    case 'bell':
      return bellSequence()
    case 'off':
      return ''
  }
}

/** How long a finished turn waits, unanswered and unwatched, before one reminder. */
export const IDLE_REMINDER_MS = 60_000

/** The one reminder a finished turn sends if nobody comes back to it. */
export function idleReminderSpec(workspaceName?: string): NotifySpec {
  return {
    title: workspaceName ? `Houston · ${workspaceName}` : 'Houston',
    body: 'Houston is waiting for your next message'
  }
}

/** OSC 0: set both the window and the icon/tab title. */
export function titleSequence(text: string): string {
  return `${ESC}]0;${sanitize(text)}${BEL}`
}

/**
 * OSC 9 + OSC 777: a desktop notification from inside the terminal, with no
 * helper binary and no platform-specific code.
 */
export function notifySequence(spec: NotifySpec): string {
  const title = sanitize(spec.title)
  const body = sanitize(spec.body)
  return `${ESC}]9;${title}: ${body}${BEL}${ESC}]777;notify;${title};${body}${BEL}`
}

/** The bell. */
export function bellSequence(): string {
  return BEL
}

/**
 * Strip control characters and cap the length.
 *
 * These strings are built from tool summaries, questions, and error text — some
 * of which is remote (an MCP server's message, a fetched page's error). BEL and
 * ESC terminate an OSC payload, so leaving them in would let that text close our
 * sequence and start its own: the whole point of an OSC injection.
 */
function sanitize(s: string, max = 120): string {
  const clean = stripControlChars(s).replace(/;/g, ',') // `;` separates OSC params
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/**
 * The chat's title as the tab shows it: '' for a chat that has none yet (the
 * "New chat" placeholder, or no chat at all), so the tab falls back to "Houston".
 */
function chatName(chatTitle?: string | null): string {
  const t = chatTitle ? stripControlChars(chatTitle).trim() : ''
  return t && t !== 'New chat' ? t : ''
}

/**
 * The title shown while the agent is working, so a glance at the tab tells you. The
 * chat's title follows the state when it has one, then the project.
 */
export function workingTitle(label: string, workspaceName?: string, chatTitle?: string | null): string {
  return [`● ${label}`, chatName(chatTitle), workspaceName].filter(Boolean).join(' · ')
}

/**
 * The title shown when nothing is running: the chat's title (derived from its first
 * message, generated, or chosen with `--name` or /rename) and the project, or
 * "Houston" and the project before the chat has one.
 */
export function idleTitle(workspaceName?: string, chatTitle?: string | null): string {
  return [chatName(chatTitle) || 'Houston', workspaceName].filter(Boolean).join(' · ')
}

/**
 * Decide what an event should signal.
 *
 * `blocking` events (an approval, a question, a plan) are the ones that matter
 * most: the run has STOPPED and is waiting on a human. `done` matters because it
 * is the "come back" moment. Everything else is silent — a bell per tool call
 * would train people to ignore the bell, which costs more than it buys.
 */
export function signalFor(e: AgentEvent, workspaceName?: string, chatTitle?: string | null): TerminalSignal | null {
  const spec = notificationFor(e, workspaceName)
  if (!spec) return null
  switch (e.type) {
    case 'tool_approval':
      return { title: workingTitle('needs approval', workspaceName, chatTitle), alert: spec }
    case 'tool_question':
      return { title: workingTitle('needs an answer', workspaceName, chatTitle), alert: spec }
    case 'plan_ready':
      return { title: workingTitle('plan ready', workspaceName, chatTitle), alert: spec }
    case 'error':
      return { title: workingTitle('error', workspaceName, chatTitle), alert: spec }
    case 'done':
      return { title: idleTitle(workspaceName, chatTitle), alert: spec }
    default:
      // A PR notice (tool_result) is worth a ping but shouldn't claim the title —
      // the run is still going.
      return { alert: spec }
  }
}

// --- Progress reporting -------------------------------------------------------
//
// Two ways to tell the terminal itself what a turn is doing, so a tab, a taskbar
// button or a session list can show it without anyone reading the screen:
//
// - OSC 9;4, the progress bar ConEmu introduced and Windows Terminal, Ghostty,
//   WezTerm and iTerm2 (3.6 and later) draw: indeterminate while a turn runs, the
//   error state when it fails, cleared when it ends. Sent ONLY to terminals known to
//   understand it: OSC 9 is also the notification sequence, so a terminal that knows
//   OSC 9 but not 9;4 would pop a notification reading "4;3".
// - OSC 7501, the program status protocol: working, blocked on a permission or a
//   question, done, error, idle. Terminals ignore an OSC they do not know, so it is
//   sent wherever progress is on.

/** What a turn is doing, as progress reporting tells the terminal. */
export type ProgressState = 'working' | 'blocked-permission' | 'blocked-question' | 'done' | 'error' | 'idle' | 'clear'

/** Which progress sequences this terminal gets. */
export interface ProgressSupport {
  /** The OSC 9;4 progress bar. */
  osc94: boolean
  /** Wrap every sequence for tmux's passthrough. */
  tmux: boolean
}

export type ProgressMode = 'auto' | 'passthrough' | 'off'

/** Whether a value is a `tuiProgress` mode. */
export function isProgressMode(v: unknown): v is ProgressMode {
  return v === 'auto' || v === 'passthrough' || v === 'off'
}

/** Whether `v` ("3.6.2") is at least major.minor. */
function versionAtLeast(v: string | undefined, major: number, minor: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(v ?? '')
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a > major || (a === major && b >= minor)
}

/** Whether the terminal itself (not a multiplexer in it) is known to draw OSC 9;4. */
export function supportsOsc94(env: NodeJS.ProcessEnv): boolean {
  if (env.WT_SESSION) return true // Windows Terminal
  if (env.ConEmuANSI === 'ON') return true
  const prog = env.TERM_PROGRAM
  if (prog === 'ghostty' || prog === 'WezTerm') return true
  if (prog === 'iTerm.app') return versionAtLeast(env.TERM_PROGRAM_VERSION, 3, 6)
  return false
}

/**
 * What this session sends, from the `tuiProgress` setting and the environment: null
 * (nothing) when it is off, and inside tmux or screen unless the setting asks for
 * tmux's passthrough (screen has no equivalent). Screen-reader mode is the adapter's
 * check, since it can change mid-session.
 */
export function progressSupport(mode: unknown, env: NodeJS.ProcessEnv): ProgressSupport | null {
  const m: ProgressMode = isProgressMode(mode) ? mode : 'auto'
  if (m === 'off') return null
  if (env.STY) return null
  const tmux = Boolean(env.TMUX)
  if (tmux && m !== 'passthrough') return null
  return { osc94: supportsOsc94(env), tmux }
}

/** Base64 of a short label for OSC 7501's `title`: no control characters, at most 120 bytes. */
function b64Label(text: string): string {
  let t = sanitize(text, 120)
  while (Buffer.byteLength(t, 'utf8') > 120) t = t.slice(0, -1)
  return Buffer.from(t, 'utf8').toString('base64')
}

/** The OSC 9;4 part for a state. */
function osc94(state: ProgressState): string {
  switch (state) {
    case 'working':
      return `${ESC}]9;4;3${BEL}`
    case 'blocked-permission':
    case 'blocked-question':
      // Paused: the bar stays up, in the terminal's waiting colour.
      return `${ESC}]9;4;4;100${BEL}`
    case 'error':
      return `${ESC}]9;4;2;100${BEL}`
    case 'done':
    case 'idle':
    case 'clear':
      return `${ESC}]9;4;0${BEL}`
  }
}

const ST = `${ESC}\\`

/** The OSC 7501 report for a state. */
function osc7501(state: ProgressState, label?: string): string {
  if (state === 'clear') return `${ESC}]7501;state=clear${ST}`
  const pairs =
    state === 'blocked-permission'
      ? ['state=blocked', 'kind=permission']
      : state === 'blocked-question'
        ? ['state=blocked', 'kind=question']
        : [`state=${state}`]
  pairs.push('app=houston')
  if (label && sanitize(label).trim()) pairs.push(`title=${b64Label(label)}`)
  return `${ESC}]7501;${pairs.join(':')}${ST}`
}

/** A sequence wrapped for tmux's passthrough: inside, every ESC is doubled. */
function tmuxWrap(seq: string): string {
  return `${ESC}Ptmux;${seq.split(ESC).join(ESC + ESC)}${ST}`
}

/** The bytes that report `state` to a terminal with `support`. */
export function progressSequence(state: ProgressState, support: ProgressSupport, label?: string): string {
  const parts = [support.osc94 ? osc94(state) : '', osc7501(state, label)].filter(Boolean)
  return parts.map((p) => (support.tmux ? tmuxWrap(p) : p)).join('')
}

/**
 * The progress state an event moves a running turn to, or null when it changes
 * nothing: a blocking event blocks it, anything after that is work again. The end is
 * the driver's to settle (done, error, or idle after a stop).
 */
export function progressForEvent(e: AgentEvent): ProgressState | null {
  switch (e.type) {
    case 'tool_approval':
      return 'blocked-permission'
    case 'tool_question':
    case 'plan_ready':
    case 'elicitation':
      return 'blocked-question'
    case 'done':
    case 'error':
      return null
    default:
      return 'working'
  }
}
