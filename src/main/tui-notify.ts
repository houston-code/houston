import type { AgentEvent } from '@shared/agent'
import { notificationFor, type NotifySpec } from '@shared/notify'
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

/** What to write to the terminal for one event. */
export interface TerminalSignal {
  /** Ambient tab/window title (always safe to set). */
  title?: string
  /** Ring the bell + fire a notification (only when the user is away). */
  alert?: NotifySpec
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

/** The title shown while the agent is working, so a glance at the tab tells you. */
export function workingTitle(label: string, workspaceName?: string): string {
  return workspaceName ? `● ${label} · ${workspaceName}` : `● ${label}`
}

/** The title shown when nothing is running. */
export function idleTitle(workspaceName?: string): string {
  return workspaceName ? `Houston · ${workspaceName}` : 'Houston'
}

/**
 * Decide what an event should signal.
 *
 * `blocking` events (an approval, a question, a plan) are the ones that matter
 * most: the run has STOPPED and is waiting on a human. `done` matters because it
 * is the "come back" moment. Everything else is silent — a bell per tool call
 * would train people to ignore the bell, which costs more than it buys.
 */
export function signalFor(e: AgentEvent, workspaceName?: string): TerminalSignal | null {
  const spec = notificationFor(e, workspaceName)
  if (!spec) return null
  switch (e.type) {
    case 'tool_approval':
      return { title: workingTitle('needs approval', workspaceName), alert: spec }
    case 'tool_question':
      return { title: workingTitle('needs an answer', workspaceName), alert: spec }
    case 'plan_ready':
      return { title: workingTitle('plan ready', workspaceName), alert: spec }
    case 'error':
      return { title: workingTitle('error', workspaceName), alert: spec }
    case 'done':
      return { title: idleTitle(workspaceName), alert: spec }
    default:
      // A PR notice (tool_result) is worth a ping but shouldn't claim the title —
      // the run is still going.
      return { alert: spec }
  }
}
