import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { BackgroundShellInfo } from '@shared/agent'
import { killProcessTree } from '../sandbox'
import { detectLocalUrl } from './loopback'
import type { PreviewServer } from '@shared/preview'

/**
 * Registry of background shells started by `run_shell` with `background: true`.
 * Each keeps a rolling output buffer the agent can poll with `read_shell_output`
 * and terminate with `kill_shell`. Shells persist across tool calls until killed
 * or the app quits (see killAllShells, wired on app shutdown).
 *
 * Each shell's output is also sniffed for the loopback URL a dev server announces
 * on startup (see detectLocalUrl); the first match is exposed as `previewUrl` and
 * powers the renderer's Preview dock. The `onShellsChanged` listeners fire when a
 * shell appears, first reveals a URL, or exits, so both the background-tasks
 * indicator and the Preview dock refresh live without polling.
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
  startedAt: number
  exitedAt: number | null
  /** Conversation whose agent run spawned this shell (for renderer navigation). */
  conversationId?: string
  /** First loopback URL the server printed (e.g. http://localhost:5173), if any. */
  previewUrl?: string
}

/** Keep at most this many trailing bytes per stream (rolling window). */
const MAX_BUF = 2_000_000

const shells = new Map<string, Shell>()

/**
 * Listeners notified whenever the shell registry changes (a shell starts, exits,
 * or first reveals its dev-server URL). The IPC layer subscribes to broadcast the
 * new list to the renderer so the background-tasks indicator and the Preview dock
 * stay live without polling. Kept here, Electron-free, so the registry stays
 * unit-testable.
 */
const changedListeners = new Set<(shells: BackgroundShellInfo[]) => void>()

/** Subscribe to registry changes; returns an unsubscribe function. */
export function onShellsChanged(fn: (shells: BackgroundShellInfo[]) => void): () => void {
  changedListeners.add(fn)
  return () => changedListeners.delete(fn)
}

function notifyShellsChanged(): void {
  const list = listShells()
  for (const fn of changedListeners) fn(list)
}

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
export function registerShell(
  command: string,
  child: ChildProcess,
  conversationId?: string
): string {
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
    running: true,
    startedAt: Date.now(),
    exitedAt: null,
    ...(conversationId ? { conversationId } : {})
  }
  // Sniff a freshly arrived chunk for the dev server's loopback URL until one is
  // found. Most servers print it on a single line early on, so scanning the chunk
  // (not the whole rolling buffer) is enough and bounded. A first match is a
  // registry change (the Preview dock can now show the pane), so notify.
  const sniff = (chunk: string): void => {
    if (shell.previewUrl) return
    const url = detectLocalUrl(chunk)
    if (url) {
      shell.previewUrl = url
      notifyShellsChanged()
    }
  }
  child.stdout?.on('data', (c: Buffer) => {
    const s = c.toString()
    shell.stdoutProduced += s.length
    shell.stdout = appendCapped(shell.stdout, s)
    sniff(s)
  })
  child.stderr?.on('data', (c: Buffer) => {
    const s = c.toString()
    shell.stderrProduced += s.length
    shell.stderr = appendCapped(shell.stderr, s)
    sniff(s)
  })
  child.on('close', (code) => {
    shell.running = false
    shell.exitCode = code
    shell.exitedAt = Date.now()
    notifyShellsChanged()
  })
  child.on('error', () => {
    shell.running = false
    shell.exitedAt = Date.now()
    notifyShellsChanged()
  })
  shells.set(id, shell)
  notifyShellsChanged()
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

/**
 * Whether the process group a background shell led still has live members after the
 * shell itself exited. Background shells are spawned `detached` (see the sandbox
 * backends), so the shell's pid is its group id, and anything it started with a
 * trailing `&` stays in that group after the shell exits (a dev server launched as
 * `npm run dev > log 2>&1 & sleep 3`). Signal 0 probes without delivering anything.
 * POSIX only: Windows has no process groups here and tree-kills by parent pid, which
 * an exited parent no longer anchors.
 */
function groupHasLiveMembers(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === 'win32') return false
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    // ESRCH: the group is empty. EPERM: not ours to signal. Either way, nothing to reap.
    return false
  }
}

/**
 * Outcome of {@link killShell}:
 * - `killed`: the shell was running and its process tree was stopped.
 * - `killed-leftovers`: the shell had already exited but left processes running in
 *   its group (typically a server it backgrounded), and those were stopped.
 * - `already-exited`: the shell and everything it started had already ended.
 * - `not-found`: no shell with that id.
 */
export type KillShellResult = 'killed' | 'killed-leftovers' | 'already-exited' | 'not-found'

/**
 * Stop a background shell and its process tree. A shell that already exited is still
 * checked for leftover group members, because "exited" only means the shell's own
 * process ended: a server it backgrounded keeps running (and holding its port) until
 * the group is signalled.
 */
export function killShell(id: string): KillShellResult {
  const s = shells.get(id)
  if (!s) return 'not-found'
  if (s.running) {
    killProcessTree(s.child)
    return 'killed'
  }
  if (groupHasLiveMembers(s.child.pid)) {
    killProcessTree(s.child)
    return 'killed-leftovers'
  }
  return 'already-exited'
}

export function listShells(): BackgroundShellInfo[] {
  return [...shells.values()].map((s) => ({
    id: s.id,
    command: s.command,
    running: s.running,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    exitedAt: s.exitedAt,
    ...(s.conversationId ? { conversationId: s.conversationId } : {})
  }))
}

/**
 * The started dev servers the Preview dock can show: every background shell,
 * mapped to the renderer-facing shape (its detected loopback URL, if any). The
 * renderer decides which are previewable (running + has a URL) — see
 * selectPreviewPanes.
 */
export function listPreviewServers(): PreviewServer[] {
  return [...shells.values()].map((s) => ({
    id: s.id,
    command: s.command,
    running: s.running,
    ...(s.previewUrl ? { url: s.previewUrl } : {})
  }))
}

/** Kill every tracked shell, and any leftovers of exited ones, then clear the registry (wired on app shutdown). */
export function killAllShells(): void {
  for (const s of shells.values()) {
    if (s.running || groupHasLiveMembers(s.child.pid)) killProcessTree(s.child)
  }
  shells.clear()
  notifyShellsChanged()
}
