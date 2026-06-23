import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killProcessTree } from '../sandbox'

/**
 * Registry of background shells started by `run_shell` with `background: true`.
 * Each keeps a rolling output buffer the agent can poll with `read_shell_output`
 * and terminate with `kill_shell`. Shells persist across tool calls until killed
 * or the app quits (see killAllShells, wired on app shutdown).
 */

interface Shell {
  id: string
  command: string
  child: ChildProcess
  stdout: string
  stderr: string
  /** Total bytes ever produced on each stream (monotonic; survives buffer trims). */
  stdoutProduced: number
  stderrProduced: number
  /** Read cursors in "total produced" coordinates, so incremental reads stay correct. */
  readStdout: number
  readStderr: number
  exitCode: number | null
  running: boolean
}

/** Keep at most this many trailing bytes per stream (rolling window). */
const MAX_BUF = 2_000_000

const shells = new Map<string, Shell>()

function appendCapped(buf: string, chunk: string): string {
  const next = buf + chunk
  return next.length > MAX_BUF ? next.slice(next.length - MAX_BUF) : next
}

/**
 * Return the not-yet-read tail of a rolling buffer. `cursor` and `produced` are in
 * absolute "total bytes produced" coordinates; the buffer only holds the trailing
 * `buffer.length` of those `produced` bytes, so `produced - buffer.length` is how
 * many leading bytes were dropped. Clamping to 0 means a poller that fell behind
 * the rolling window gets the whole current buffer (never silently nothing).
 */
export function unreadSlice(buffer: string, produced: number, cursor: number): string {
  const dropped = produced - buffer.length
  const start = Math.max(0, cursor - dropped)
  return buffer.slice(start)
}

/** Register a freshly spawned background child and start capturing its output. */
export function registerShell(command: string, child: ChildProcess): string {
  const id = randomUUID().slice(0, 8)
  const shell: Shell = {
    id,
    command,
    child,
    stdout: '',
    stderr: '',
    stdoutProduced: 0,
    stderrProduced: 0,
    readStdout: 0,
    readStderr: 0,
    exitCode: null,
    running: true
  }
  child.stdout?.on('data', (c: Buffer) => {
    const s = c.toString()
    shell.stdoutProduced += s.length
    shell.stdout = appendCapped(shell.stdout, s)
  })
  child.stderr?.on('data', (c: Buffer) => {
    const s = c.toString()
    shell.stderrProduced += s.length
    shell.stderr = appendCapped(shell.stderr, s)
  })
  child.on('close', (code) => {
    shell.running = false
    shell.exitCode = code
  })
  child.on('error', () => {
    shell.running = false
  })
  shells.set(id, shell)
  return id
}

export interface ShellOutput {
  found: boolean
  running: boolean
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Read output from a background shell. By default returns only output produced
 * since the previous read; pass `full` to return everything still buffered.
 */
export function readShellOutput(id: string, opts: { full?: boolean } = {}): ShellOutput {
  const s = shells.get(id)
  if (!s) return { found: false, running: false, exitCode: null, stdout: '', stderr: '' }
  const stdout = opts.full ? s.stdout : unreadSlice(s.stdout, s.stdoutProduced, s.readStdout)
  const stderr = opts.full ? s.stderr : unreadSlice(s.stderr, s.stderrProduced, s.readStderr)
  s.readStdout = s.stdoutProduced
  s.readStderr = s.stderrProduced
  return { found: true, running: s.running, exitCode: s.exitCode, stdout, stderr }
}

/** Kill a running background shell (and its process tree). Returns false if unknown. */
export function killShell(id: string): boolean {
  const s = shells.get(id)
  if (!s) return false
  if (s.running) killProcessTree(s.child)
  return true
}

export interface ShellInfo {
  id: string
  command: string
  running: boolean
  exitCode: number | null
}

export function listShells(): ShellInfo[] {
  return [...shells.values()].map((s) => ({
    id: s.id,
    command: s.command,
    running: s.running,
    exitCode: s.exitCode
  }))
}

/** Kill every tracked shell and clear the registry (wired on app shutdown). */
export function killAllShells(): void {
  for (const s of shells.values()) if (s.running) killProcessTree(s.child)
  shells.clear()
}
