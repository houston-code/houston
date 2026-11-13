import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync, statSync } from 'node:fs'
import * as pty from 'node-pty'
import type { IPty } from 'node-pty'
import { IPC } from '@shared/constants'
import { SHELL_ESCAPE_MAX_CHARS, plainTerminalText } from '@shared/shellEscape'

/**
 * Registry of interactive terminals backing the in-app terminal panel.
 *
 * Unlike the agent's background shells (see agent/shells.ts), these are full
 * pseudo-terminals (node-pty): the user types into them directly, so they carry
 * a TTY — colours, cursor control, `vim`/`top`, Ctrl-C, and resize all work.
 *
 * IMPORTANT — these run UNSANDBOXED, with the user's full privileges. That is by
 * design: this is the user's own terminal, the same trust level as any terminal
 * app. It is deliberately separate from the agent's sandbox-exec path
 * (see sandbox.ts), which confines model-driven commands.
 *
 * Output is pushed to the renderer (event-driven), not polled, because an
 * interactive terminal streams continuously. Bursts within a single tick are
 * coalesced into one IPC message so noisy output (a big build) doesn't flood the
 * channel one read() at a time.
 */

/** Minimal slice of Electron's WebContents we need — kept narrow so the manager
 * is unit-testable with a fake. */
export interface TerminalSender {
  send(channel: string, payload: unknown): void
  isDestroyed(): boolean
}

export interface TerminalSpawnOptions {
  /** Working directory for the shell. Falls back to the user's home dir. */
  cwd?: string
  cols?: number
  rows?: number
  /** Override the login shell (defaults to $SHELL, then /bin/zsh). */
  shell?: string
  /**
   * Run this one command instead of an interactive session: the tab shows it live,
   * and its exit reports the output as plain text (the composer's `!cmd`). The
   * shell still starts interactive, so the user's aliases, PATH and version
   * managers apply, as they would typing it at the prompt.
   */
  command?: string
}

/** What a terminal's exit reports. `output` only for a terminal that ran a command. */
export interface TerminalExit {
  id: string
  exitCode: number
  output?: string
}

interface Terminal {
  id: string
  pty: IPty
  sender: TerminalSender
  /** Coalescing buffer: output seen since the last flush. */
  pending: string
  /** Scheduled flush handle (null when nothing is buffered). */
  flush: ReturnType<typeof setImmediate> | null
  /** A command terminal's output so far (its tail, capped), or null for a shell. */
  captured: string | null
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

const terminals = new Map<string, Terminal>()

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

/**
 * The arguments that make `shell` run one command and exit. POSIX shells take it
 * after `-i -c` (interactive, so the rc file that sets up PATH is read); Windows
 * shells each have their own flag.
 */
export function commandArgs(shell: string, command: string): string[] {
  const name = shell.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'cmd.exe' || name === 'cmd') return ['/d', '/s', '/c', command]
  if (name.startsWith('powershell') || name.startsWith('pwsh')) return ['-NoLogo', '-Command', command]
  return ['-i', '-c', command]
}

/** Resolve a usable working directory, falling back to home if the requested one
 * is gone (e.g. a deleted worktree) — spawning into a missing cwd would throw. */
function resolveCwd(cwd?: string): string {
  if (cwd && existsSync(cwd) && statSync(cwd).isDirectory()) return cwd
  return homedir()
}

/** Flush a terminal's buffered output to its renderer as one message. */
function flushTerminal(term: Terminal): void {
  term.flush = null
  if (!term.pending) return
  const data = term.pending
  term.pending = ''
  if (!term.sender.isDestroyed()) term.sender.send(IPC.terminalData, { id: term.id, data })
}

/**
 * Spawn a new PTY-backed terminal and stream its output to `sender`. Returns the
 * id the renderer uses for subsequent input/resize/kill calls.
 */
export function createTerminal(sender: TerminalSender, opts: TerminalSpawnOptions = {}): string {
  const id = randomUUID().slice(0, 8)
  const cwd = resolveCwd(opts.cwd)
  const shell = opts.shell || defaultShell()
  const command = opts.command?.trim() || null
  const child = pty.spawn(shell, command ? commandArgs(shell, command) : [], {
    name: 'xterm-256color',
    cols: opts.cols ?? DEFAULT_COLS,
    rows: opts.rows ?? DEFAULT_ROWS,
    cwd,
    // A login/interactive shell inherits the user's environment. Force TERM so
    // programs emit the escape sequences xterm.js understands.
    env: { ...process.env, TERM: 'xterm-256color' }
  })
  const term: Terminal = { id, pty: child, sender, pending: '', flush: null, captured: command ? '' : null }

  child.onData((chunk) => {
    term.pending += chunk
    if (term.captured !== null) {
      // Keep the tail: errors and summaries land last. Trimmed with headroom so a
      // chatty build does not re-slice on every chunk.
      term.captured += chunk
      if (term.captured.length > SHELL_ESCAPE_MAX_CHARS * 2) {
        term.captured = term.captured.slice(-SHELL_ESCAPE_MAX_CHARS)
      }
    }
    if (term.flush === null) term.flush = setImmediate(() => flushTerminal(term))
  })
  child.onExit(({ exitCode }) => {
    // Drain anything buffered before announcing the exit so no final output is lost.
    if (term.flush !== null) {
      clearImmediate(term.flush)
      flushTerminal(term)
    }
    terminals.delete(id)
    const exit: TerminalExit = { id, exitCode }
    if (term.captured !== null) exit.output = plainTerminalText(term.captured.slice(-SHELL_ESCAPE_MAX_CHARS))
    if (!sender.isDestroyed()) sender.send(IPC.terminalExit, exit)
  })

  terminals.set(id, term)
  return id
}

/** Forward user keystrokes / pasted text to a terminal. No-op for unknown ids. */
export function writeTerminal(id: string, data: string): void {
  terminals.get(id)?.pty.write(data)
}

/** Resize a terminal's PTY to match the rendered grid. No-op for unknown ids. */
export function resizeTerminal(id: string, cols: number, rows: number): void {
  const term = terminals.get(id)
  if (!term) return
  // node-pty throws on non-positive dimensions (can happen mid-layout); guard.
  if (cols > 0 && rows > 0) term.pty.resize(cols, rows)
}

/** Kill a terminal and drop it from the registry. Returns false if unknown. */
export function killTerminal(id: string): boolean {
  const term = terminals.get(id)
  if (!term) return false
  if (term.flush !== null) clearImmediate(term.flush)
  terminals.delete(id)
  term.pty.kill()
  return true
}

/**
 * Kill every terminal a renderer opened. Call when that renderer's page is gone: its
 * window closed, it reloaded, or it crashed. The page held the only handle to them (a
 * new page starts with no tabs and has no way to re-attach), so otherwise the shells,
 * and anything started in them, kept running unseen until the app quit. Returns how
 * many were killed.
 */
export function killTerminalsOf(sender: TerminalSender): number {
  let killed = 0
  for (const term of [...terminals.values()]) {
    if (term.sender !== sender) continue
    killTerminal(term.id)
    killed++
  }
  return killed
}

/** Number of live terminals (used by tests). */
export function terminalCount(): number {
  return terminals.size
}

/** Kill every terminal — wired on app shutdown alongside killAllShells. */
export function killAllTerminals(): void {
  for (const term of terminals.values()) {
    if (term.flush !== null) clearImmediate(term.flush)
    term.pty.kill()
  }
  terminals.clear()
}
