/**
 * The `!cmd` shell escape, shared by the terminal app and the desktop composer:
 * recognizing the line, and what the model is told about a command the user ran
 * themselves. Each client runs the command its own way (the terminal app in a
 * child process, the desktop app in a terminal tab); the record is the same.
 */
import type { ChatMessage } from './agent'

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

/** The most terminal output kept for the record, before the line cap applies. */
export const SHELL_ESCAPE_MAX_CHARS = 64 * 1024

/**
 * A terminal's raw output as plain text: what was on screen, without the escape
 * sequences that drew it.
 *
 * A terminal tab is a real TTY, so programs color their output, redraw progress
 * bars with a bare carriage return, and set the window title. None of that means
 * anything to the model, and a progress bar redrawn a hundred times would be a
 * hundred lines of noise. Each line keeps what was drawn last, the way it looked.
 */
export function plainTerminalText(raw: string): string {
  const text = raw
    // OSC (title, hyperlinks, clipboard): ESC ] ... terminated by BEL or ST.
    // eslint-disable-next-line no-control-regex -- removing terminal escapes is the point
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI (colors, cursor moves, erase): ESC [ params final-byte.
    // eslint-disable-next-line no-control-regex -- removing terminal escapes is the point
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Any other two-byte escape (charset selection, keypad mode).
    // eslint-disable-next-line no-control-regex -- removing terminal escapes is the point
    .replace(/\x1b[@-_]?/g, '')
    .replace(/\r\n/g, '\n')
  return text
    .split('\n')
    .map((line) => {
      // A bare carriage return redraws the line: keep what was drawn last.
      const parts = line.split('\r').filter((p) => p !== '')
      const last = parts.length ? parts[parts.length - 1] : ''
      // eslint-disable-next-line no-control-regex -- removing control characters is the point
      return last.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    })
    .join('\n')
}

/** What recording a finished `!cmd` in its chat came to. */
export type RecordShellResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; reason: 'busy' | 'missing' }
