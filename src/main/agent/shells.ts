import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { BackgroundShellInfo, KillShellOutcome } from '@shared/agent'
import { killProcessTree } from '../sandbox'
import { detectLocalUrls, type FoundUrl } from './loopback'
import { writeShellLedger, type LedgerEntry } from './shellLedger'
import { redactSecrets } from './redact'
import type { PreviewServer } from '@shared/preview'

/**
 * Registry of background shells started by `run_shell` with `background: true`.
 * Each keeps a rolling output buffer the agent can poll with `read_shell_output`
 * and terminate with `kill_shell`. Shells persist across tool calls until killed
 * or the app quits (see killAllShells, wired on app shutdown).
 *
 * Live process groups are also written to a crash-safe ledger (see shellLedger.ts),
 * so a later launch can stop servers an exit that skipped killAllShells left behind.
 *
 * Each shell's output is also sniffed for the loopback URLs a dev server announces
 * on startup (see detectLocalUrls). One script often starts several servers (a client
 * and its API under `concurrently`), so every URL is kept, the page labeled `Local:`
 * first; they power the renderer's Preview dock and are reported to the agent by
 * read_shell_output. The `onShellsChanged` listeners fire when a shell appears,
 * reveals a new URL, or exits, so both the background-tasks indicator and the
 * Preview dock refresh live without polling.
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
  /** The workspace the shell ran in (its starting directory), for relative folder labels. */
  workspace?: string
  /**
   * Both streams' most recent output in arrival order, for the Tasks panel's output
   * tail. Kept separately from stdout/stderr because those can't be re-interleaved.
   */
  recent: string
  /**
   * Loopback URLs the shell printed (e.g. http://localhost:5173/), the ones labeled
   * as the local page first, then in the order they appeared. Capped.
   */
  previewUrls: string[]
  /** How many leading entries of {@link previewUrls} are labeled `Local:`. */
  announcedCount: number
  /** URLs read_shell_output has already reported to the agent. */
  reportedUrls: Set<string>
}

/** Most URLs kept per shell: a dev script starts a few servers, not dozens. */
const MAX_URLS = 8

/**
 * Fold newly printed URLs into a shell's list, keeping the `Local:` ones ahead of the
 * rest. Returns whether the list changed (so the Preview dock should refresh).
 */
function addPreviewUrls(shell: Shell, found: FoundUrl[]): boolean {
  let changed = false
  for (const f of found) {
    const at = shell.previewUrls.indexOf(f.url)
    if (at >= 0) {
      // Seen before but only now labeled as the local page: move it up front.
      if (!f.announced || at < shell.announcedCount) continue
      shell.previewUrls.splice(at, 1)
    } else if (shell.previewUrls.length >= MAX_URLS) {
      continue
    }
    if (f.announced) shell.previewUrls.splice(shell.announcedCount++, 0, f.url)
    else shell.previewUrls.push(f.url)
    changed = true
  }
  return changed
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

/**
 * Rewrite this process's ledger with every group that still has a live member: a
 * running shell, or an exited one whose backgrounded server still runs. Dropping
 * emptied groups at each write is what lets the reaper rule out a recycled group id.
 */
function persistLedger(): void {
  const entries: LedgerEntry[] = []
  for (const s of shells.values()) {
    const pid = s.child.pid
    if (pid === undefined) continue
    if (s.running || groupHasLiveMembers(pid)) entries.push({ pgid: pid, startedAt: s.startedAt })
  }
  writeShellLedger(entries)
}

/** Trailing characters of interleaved output kept for the Tasks panel's tail. */
const MAX_RECENT = 16_000

function appendRecent(buf: string, chunk: string): string {
  const next = buf + chunk
  return next.length > MAX_RECENT ? next.slice(next.length - MAX_RECENT) : next
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
  conversationId?: string,
  workspace?: string
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
    previewUrls: [],
    announcedCount: 0,
    reportedUrls: new Set(),
    recent: '',
    ...(conversationId ? { conversationId } : {}),
    ...(workspace ? { workspace } : {})
  }
  // Sniff each freshly arrived chunk for the loopback URLs the servers announce.
  // Servers print them on a line of their own early on, so scanning the chunk (not
  // the whole rolling buffer) is enough and bounded. A new URL is a registry change
  // (the Preview dock can show or switch the pane), so notify.
  const sniff = (chunk: string): void => {
    if (shell.previewUrls.length >= MAX_URLS && shell.announcedCount > 0) return
    if (addPreviewUrls(shell, detectLocalUrls(chunk))) notifyShellsChanged()
  }
  // One decoder per stream: a multibyte character split across two pipe chunks
  // would otherwise decode as two replacement characters.
  const outDecoder = new StringDecoder('utf8')
  const errDecoder = new StringDecoder('utf8')
  child.stdout?.on('data', (c: Buffer) => {
    const s = outDecoder.write(c)
    shell.stdoutProduced += s.length
    shell.stdout = appendCapped(shell.stdout, s)
    shell.recent = appendRecent(shell.recent, s)
    sniff(s)
  })
  child.stderr?.on('data', (c: Buffer) => {
    const s = errDecoder.write(c)
    shell.stderrProduced += s.length
    shell.stderr = appendCapped(shell.stderr, s)
    shell.recent = appendRecent(shell.recent, s)
    sniff(s)
  })
  child.on('close', (code) => {
    shell.running = false
    shell.exitCode = code
    shell.exitedAt = Date.now()
    persistLedger()
    notifyShellsChanged()
  })
  child.on('error', () => {
    shell.running = false
    shell.exitedAt = Date.now()
    persistLedger()
    notifyShellsChanged()
  })
  shells.set(id, shell)
  persistLedger()
  notifyShellsChanged()
  return id
}

export interface ShellOutput {
  found: boolean
  running: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  /** Loopback URLs the shell printed that no earlier read reported, `Local:` ones first. */
  newUrls: string[]
}

/**
 * Read output from a background shell. By default returns only output produced
 * since the previous read; pass `full` to return everything still buffered.
 */
export function readShellOutput(id: string, opts: { full?: boolean } = {}): ShellOutput {
  const s = shells.get(id)
  if (!s) return { found: false, running: false, exitCode: null, stdout: '', stderr: '', newUrls: [] }
  const stdout = opts.full ? s.stdout : unreadSlice(s.stdout, s.stdoutProduced, s.readStdout)
  const stderr = opts.full ? s.stderr : unreadSlice(s.stderr, s.stderrProduced, s.readStderr)
  s.readStdout = s.stdoutProduced
  s.readStderr = s.stderrProduced
  // A full re-read restates every URL; an incremental one only those not yet reported.
  const newUrls = opts.full ? [...s.previewUrls] : s.previewUrls.filter((u) => !s.reportedUrls.has(u))
  for (const u of newUrls) s.reportedUrls.add(u)
  return { found: true, running: s.running, exitCode: s.exitCode, stdout, stderr, newUrls }
}

/** How much of a background shell's output {@link peekShell} returns: the tail, where a summary is. */
const PEEK_TAIL_CHARS = 16_000

/**
 * A background shell's state without reading it: whether it is still running, its exit
 * code, and the tail of what it printed. Unlike {@link readShellOutput} it moves no read
 * cursor, so the turn's receipt can look at a shell without hiding new output from the
 * agent's next read_shell_output. Undefined for an unknown id.
 */
export function peekShell(id: string): { running: boolean; exitCode: number | null; output: string } | undefined {
  const s = shells.get(id)
  if (!s) return undefined
  const output = [s.stdout, s.stderr].filter(Boolean).join('\n')
  return { running: s.running, exitCode: s.exitCode, output: output.slice(-PEEK_TAIL_CHARS) }
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
export type KillShellResult = KillShellOutcome

/** Delay before re-broadcasting after stopping a leftover, so the list sees it gone. */
const LEFTOVER_SETTLE_MS = 300

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
    persistLedger()
    // No 'close' event follows (the shell already exited), so tell listeners the
    // leftover is gone once SIGKILL has had a moment to land.
    setTimeout(notifyShellsChanged, LEFTOVER_SETTLE_MS).unref?.()
    return 'killed-leftovers'
  }
  return 'already-exited'
}

/** The process groups of every background shell this run of Houston started. */
export function backgroundShellGroups(): Set<number> {
  const out = new Set<number>()
  for (const s of shells.values()) if (s.child.pid !== undefined) out.add(s.child.pid)
  return out
}

export function listShells(): BackgroundShellInfo[] {
  return [...shells.values()].map((s) => ({
    id: s.id,
    command: s.command,
    running: s.running,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    exitedAt: s.exitedAt,
    // An exited shell whose group still has members left a process running (most
    // often a server it backgrounded). Probed at list time, so a refresh of the list
    // also notices when that leftover finally goes away.
    ...(!s.running && groupHasLiveMembers(s.child.pid) ? { leftover: true } : {}),
    ...(s.previewUrls.length ? { urls: [...s.previewUrls] } : {}),
    ...(s.conversationId ? { conversationId: s.conversationId } : {}),
    ...(s.workspace ? { workspace: s.workspace } : {})
  }))
}

/** Terminal color/cursor escape sequences, which would show as junk in the panel. */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

/** Most lines {@link shellTail} returns. */
const TAIL_MAX_LINES = 40

/**
 * The last lines a background shell printed (both streams, in arrival order) with
 * secrets masked, for the Tasks panel. Read-only: moves no read cursor, so showing it
 * never hides output from the agent's next read_shell_output. Undefined for an
 * unknown id.
 */
export function shellTail(id: string, maxLines = TAIL_MAX_LINES): string[] | undefined {
  const s = shells.get(id)
  if (!s) return undefined
  const n = Math.max(1, Math.min(TAIL_MAX_LINES, Math.floor(maxLines) || TAIL_MAX_LINES))
  const lines = redactSecrets(s.recent.replace(ANSI_ESCAPE, ''))
    // A progress bar redraws its line with \r; keep only the last redraw.
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).trimEnd())
    .filter((l) => l.length > 0)
  return lines.slice(-n)
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
    ...(s.previewUrls.length ? { url: s.previewUrls[0], urls: [...s.previewUrls] } : {})
  }))
}

/** Kill every tracked shell, and any leftovers of exited ones, then clear the registry (wired on app shutdown). */
export function killAllShells(): void {
  for (const s of shells.values()) {
    if (s.running || groupHasLiveMembers(s.child.pid)) killProcessTree(s.child)
  }
  shells.clear()
  writeShellLedger([])
  notifyShellsChanged()
}
