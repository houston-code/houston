import { execFileSync, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { BackgroundShellInfo, KillShellOutcome } from '@shared/agent'
import { KILL_GRACE_MS, killProcessTree, signalProcessTree } from '../sandbox'
import { detectLocalUrls, stripAnsi, type FoundUrl } from './loopback'
import { writeShellLedger, type LedgerEntry } from './shellLedger'
import { redactSecrets } from './redact'
import { collectSecrets } from '../agentHost'
import type { PreviewServer } from '@shared/preview'
import { discardShellEvents, pushBackgroundEvent, MAX_MATCH_LINES } from './backgroundEvents'

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
   * The shell exited AND a probe found its process group empty. Latched: once a group
   * is empty its id can be recycled by an unrelated group leader, so it is never
   * probed or signalled again (a later probe could otherwise "find" that stranger).
   */
  groupGone?: boolean
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
  /** Pending SIGKILL escalation after a graceful stop's SIGTERM (see {@link stopGracefully}). */
  stopTimer?: ReturnType<typeof setTimeout>
  /**
   * What ended the shell when the command didn't end on its own: the agent's
   * kill_shell, the user's Stop, the cancelled turn that started it, or the app
   * shutting down. Decides whether (and how) its exit is reported to the agent.
   */
  stoppedBy?: 'agent' | 'user' | 'cancel' | 'app'
  /** Lowercased phrases whose lines are reported to the agent as they print (run_shell notify_on). */
  notifyOn: string[]
  /** The phrases as the agent gave them, for the report. */
  notifyOnRaw: string[]
  /** Matching lines reported so far; watching stops at {@link MAX_WATCH_MATCHES}. */
  matchCount: number
  /** Each stream's unfinished last line, held until its newline arrives. */
  carryOut: string
  carryErr: string
}

/** Most phrases one shell can watch for. */
export const MAX_NOTIFY_PATTERNS = 5
/** Longest watch phrase accepted. */
export const MAX_NOTIFY_PATTERN_LENGTH = 200
/** Most matching lines reported per shell before watching stops (a chatty log can't flood the chat). */
export const MAX_WATCH_MATCHES = 50
/** Longest line checked for a watch phrase, and longest kept in a report. */
const MAX_WATCH_LINE = 4_000
const MAX_REPORTED_LINE = 500
/** How much of the end of a shell's output its exit report carries. */
const EXIT_TAIL_LINES = 20
const EXIT_TAIL_CHARS = 2_000

/**
 * Normalize run_shell's notify_on: trimmed, non-empty, de-duplicated phrases, at most
 * {@link MAX_NOTIFY_PATTERNS} of at most {@link MAX_NOTIFY_PATTERN_LENGTH} characters.
 * Plain substrings (matched case-insensitively), never regular expressions: a pattern
 * the model writes runs against every line a server prints, in the main process, so a
 * backtracking regex there could stall the app.
 */
export function normalizeNotifyOn(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const out: string[] = []
  for (const v of list) {
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, MAX_NOTIFY_PATTERN_LENGTH)
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
    if (out.length >= MAX_NOTIFY_PATTERNS) break
  }
  return out
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

/**
 * Most finished shells kept for reading back. A shell that exited and left nothing
 * running is only history: its two output windows (megabytes each) would otherwise
 * stay in memory until the app quits, for every shell a long session ever started.
 */
export const MAX_EXITED_SHELLS = 30

const shells = new Map<string, Shell>()

/**
 * Forget the oldest finished shells beyond {@link MAX_EXITED_SHELLS}. Only a shell
 * whose process group is known to be empty goes: one with a leftover server still
 * needs its row in the Tasks panel and its group id for Stop.
 */
function pruneExited(): void {
  const done = [...shells.values()].filter((s) => !s.running && !hasLeftover(s))
  if (done.length <= MAX_EXITED_SHELLS) return
  done.sort((a, b) => (a.exitedAt ?? 0) - (b.exitedAt ?? 0))
  for (const s of done.slice(0, done.length - MAX_EXITED_SHELLS)) shells.delete(s.id)
}

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
    if (s.running || hasLeftover(s)) entries.push({ pgid: pid, startedAt: s.startedAt })
  }
  writeShellLedger(entries)
}

/** Trailing characters of interleaved output kept for the Tasks panel's tail. */
const MAX_RECENT = 16_000

function appendRecent(buf: string, chunk: string): string {
  const next = buf + chunk
  return next.length > MAX_RECENT ? next.slice(next.length - MAX_RECENT) : next
}

/**
 * Append to a rolling buffer whose readable window is its last `max` chars. Trimming
 * to exactly `max` on every chunk flattened and copied the whole window each time
 * (megabytes per chunk once a chatty server filled it), so the buffer is allowed to
 * run up to twice the window before it is cut back. Readers go through
 * {@link windowOf}, so what they see is unchanged.
 */
export function appendCapped(buf: string, chunk: string, max = MAX_BUF): string {
  const next = buf + chunk
  return next.length > max * 2 ? next.slice(next.length - max) : next
}

/** The readable window of a buffer built by {@link appendCapped}: its last `max` chars. */
export function windowOf(buf: string, max = MAX_BUF): string {
  return buf.length > max ? buf.slice(buf.length - max) : buf
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
  workspace?: string,
  opts: {
    /** The run's abort signal: a shell that ends because the turn was cancelled says so. */
    signal?: AbortSignal
    /** Phrases whose lines are reported to the agent as they print (see normalizeNotifyOn). */
    notifyOn?: string[]
  } = {}
): string {
  const notifyOnRaw = normalizeNotifyOn(opts.notifyOn)
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
    notifyOn: notifyOnRaw.map((p) => p.toLowerCase()),
    notifyOnRaw,
    matchCount: 0,
    carryOut: '',
    carryErr: '',
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
  const onOut = (s: string): void => {
    if (!s) return
    shell.stdoutProduced += s.length
    shell.stdout = appendCapped(shell.stdout, s)
    shell.recent = appendRecent(shell.recent, s)
    sniff(s)
    shell.carryOut = watchLines(shell, shell.carryOut + s)
  }
  const onErr = (s: string): void => {
    if (!s) return
    shell.stderrProduced += s.length
    shell.stderr = appendCapped(shell.stderr, s)
    shell.recent = appendRecent(shell.recent, s)
    sniff(s)
    shell.carryErr = watchLines(shell, shell.carryErr + s)
  }
  child.stdout?.on('data', (c: Buffer) => onOut(outDecoder.write(c)))
  child.stderr?.on('data', (c: Buffer) => onErr(errDecoder.write(c)))
  // Nothing more will be appended: flush any partial character the decoders still
  // hold (as U+FFFD, rather than dropping it), then give back the slack
  // appendCapped let build up.
  const settle = (): void => {
    onOut(outDecoder.end())
    onErr(errDecoder.end())
    shell.stdout = windowOf(shell.stdout)
    shell.stderr = windowOf(shell.stderr)
  }
  // Both 'error' (a failed spawn) and 'close' can fire for one child; report once.
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    settle()
    // A last line printed without a trailing newline is still a line.
    shell.carryOut = watchLines(shell, `${shell.carryOut}\n`)
    shell.carryErr = watchLines(shell, `${shell.carryErr}\n`)
    if (!shell.stoppedBy && opts.signal?.aborted) shell.stoppedBy = 'cancel'
    reportExit(shell)
  }
  child.on('close', (code) => {
    shell.running = false
    shell.exitCode = code
    shell.exitedAt = Date.now()
    end()
    persistLedger()
    notifyShellsChanged()
    watchLeftovers()
  })
  child.on('error', () => {
    shell.running = false
    shell.exitedAt = Date.now()
    end()
    persistLedger()
    notifyShellsChanged()
    watchLeftovers()
  })
  pruneExited()
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
  const out = windowOf(s.stdout)
  const err = windowOf(s.stderr)
  const stdout = opts.full ? out : unreadSlice(out, s.stdoutProduced, s.readStdout)
  const stderr = opts.full ? err : unreadSlice(err, s.stderrProduced, s.readStderr)
  s.readStdout = s.stdoutProduced
  s.readStderr = s.stderrProduced
  // A full re-read restates every URL; an incremental one only those not yet reported.
  const newUrls = opts.full ? [...s.previewUrls] : s.previewUrls.filter((u) => !s.reportedUrls.has(u))
  for (const u of newUrls) s.reportedUrls.add(u)
  // The agent now has this output (and, once exited, the exit) first-hand: news about
  // it still waiting would only repeat it.
  if (s.conversationId) discardShellEvents(s.conversationId, s.id, { exited: !s.running })
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
  const output = [windowOf(s.stdout), windowOf(s.stderr)].filter(Boolean).join('\n')
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
 * Whether an exited shell left processes running in its group. Latches
 * {@link Shell.groupGone} the first time the group is found empty, so a recycled
 * group id is never mistaken for a leftover (and never signalled) afterwards, and
 * a long session stops paying a probe for every shell that ever finished.
 */
function hasLeftover(s: Shell): boolean {
  if (s.running || s.groupGone) return false
  if (groupHasLiveMembers(s.child.pid)) return true
  s.groupGone = true
  return false
}

/** How often main re-probes leftover groups so the panel and badge see them go away. */
const LEFTOVER_WATCH_MS = 5000
let leftoverWatch: ReturnType<typeof setInterval> | null = null

/**
 * While any exited shell still has a leftover, re-probe on a timer and broadcast when
 * one goes away: nothing else announces that (no 'close' fires for a grandchild), so
 * without this the titlebar badge would keep counting a server that already died.
 * Stops itself once no leftovers remain.
 */
function watchLeftovers(): void {
  if (leftoverWatch) return
  const pending = (): Shell[] => [...shells.values()].filter((s) => !s.running && !s.groupGone)
  if (pending().length === 0) return
  leftoverWatch = setInterval(() => {
    let changed = false
    for (const s of pending()) if (!hasLeftover(s)) changed = true
    if (changed) {
      persistLedger()
      notifyShellsChanged()
    }
    if (pending().length === 0 && leftoverWatch) {
      clearInterval(leftoverWatch)
      leftoverWatch = null
    }
  }, LEFTOVER_WATCH_MS)
  leftoverWatch.unref?.()
}

/**
 * Text bound for the renderer (a command line, an output tail) with secrets masked:
 * pattern-matched tokens plus the host's own configured credentials, the same two
 * layers the agent's tool output gets.
 */
function maskForUi(text: string): string {
  let known: string[] = []
  try {
    known = collectSecrets()
  } catch {
    // No agent host (unit tests, early startup): pattern masking still applies.
  }
  return redactSecrets(text, known)
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
 * Ask a shell's process tree to stop: SIGTERM the group now, then SIGKILL whatever is
 * still running once the grace runs out. A server (or `docker compose up`, which only
 * stops its containers on SIGTERM) gets to shut down cleanly; one that ignores the
 * signal is still reaped. Windows has no graceful group signal (the tree kill there is
 * always forceful), so the first signal already ends it and nothing is escalated.
 */
function stopGracefully(s: Shell, graceMs: number): void {
  signalProcessTree(s.child, 'SIGTERM')
  if (process.platform === 'win32' || s.stopTimer) return
  s.stopTimer = setTimeout(() => {
    s.stopTimer = undefined
    // hasLeftover latches an empty group, so a recycled group id is never signalled.
    if (s.running || hasLeftover(s)) killProcessTree(s.child)
    persistLedger()
    setTimeout(notifyShellsChanged, LEFTOVER_SETTLE_MS).unref?.()
  }, graceMs)
  s.stopTimer.unref?.()
}

/**
 * Stop a background shell and its process tree: SIGTERM first, SIGKILL after
 * `graceMs` (the same grace a timed-out foreground command gets) for anything that
 * ignored it. A shell that already exited is still checked for leftover group members,
 * because "exited" only means the shell's own process ended: a server it backgrounded
 * keeps running (and holding its port) until the group is signalled. Returns as soon
 * as the stop is under way; {@link stopShell} waits for it to finish.
 */
export function killShell(
  id: string,
  opts: {
    graceMs?: number
    /** Who asked: decides how the shell's exit is reported to the agent (see reportExit). */
    by?: 'agent' | 'user'
  } = {}
): KillShellResult {
  const s = shells.get(id)
  if (!s) return 'not-found'
  const graceMs = opts.graceMs ?? KILL_GRACE_MS
  if (s.running) {
    // Whoever stopped it already knows: the agent from kill_shell's result, the user
    // from their own click (the agent hears of that one, without being woken).
    s.stoppedBy ??= opts.by ?? 'agent'
    stopGracefully(s, graceMs)
    return 'killed'
  }
  if (hasLeftover(s)) {
    stopGracefully(s, graceMs)
    // No 'close' event follows (the shell already exited), so tell listeners the
    // leftover is gone once the signal has had a moment to land.
    setTimeout(notifyShellsChanged, LEFTOVER_SETTLE_MS).unref?.()
    return 'killed-leftovers'
  }
  return 'already-exited'
}

/**
 * Stop every background shell a conversation started (running ones and the leftovers of
 * exited ones) and drop them from the registry. For a chat being deleted: its dev
 * servers must not keep their ports, or show in the Tasks list, after the chat is gone.
 * Returns how many process groups were signalled.
 */
export function killShellsFor(conversationId: string): number {
  let signalled = 0
  for (const [id, s] of shells) {
    if (s.conversationId !== conversationId) continue
    // The chat is being deleted: nobody is left to tell.
    s.stoppedBy ??= 'app'
    if (s.running || hasLeftover(s)) {
      killProcessTree(s.child)
      signalled++
    }
    shells.delete(id)
  }
  if (signalled) persistLedger()
  notifyShellsChanged()
  return signalled
}

/** How often {@link stopShell} checks whether a stopping shell is gone. */
const STOP_POLL_MS = 50

/**
 * {@link killShell}, then wait until the shell and everything left in its group have
 * actually ended (at most the grace plus a moment for the SIGKILL to land), so a
 * caller that reports the shell stopped and then restarts a server on the same port
 * isn't racing the old one's shutdown.
 */
export async function stopShell(id: string, opts: { graceMs?: number } = {}): Promise<KillShellResult> {
  const result = killShell(id, opts)
  const s = shells.get(id)
  if (!s || (result !== 'killed' && result !== 'killed-leftovers')) return result
  const deadline = Date.now() + (opts.graceMs ?? KILL_GRACE_MS) + 1_000
  while ((s.running || hasLeftover(s)) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, STOP_POLL_MS))
  }
  return result
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
    // Masked: an agent command can carry an inline secret (`API_KEY=… npm run dev`),
    // and the panel shows and copies it in full.
    command: maskForUi(s.command),
    running: s.running,
    exitCode: s.exitCode,
    startedAt: s.startedAt,
    exitedAt: s.exitedAt,
    // An exited shell whose group still has members left a process running (most
    // often a server it backgrounded). Probed at list time, so a refresh of the list
    // also notices when that leftover finally goes away.
    ...(hasLeftover(s) ? { leftover: true } : {}),
    ...(s.previewUrls.length ? { urls: [...s.previewUrls] } : {}),
    ...(s.conversationId ? { conversationId: s.conversationId } : {}),
    ...(s.workspace ? { workspace: s.workspace } : {})
  }))
}

/**
 * Check each complete line of `text` against the shell's watch phrases, reporting the
 * matches to the agent's chat. Returns the unfinished remainder to carry to the next
 * chunk (bounded, so a stream with no newlines can't grow it).
 */
function watchLines(shell: Shell, text: string): string {
  if (!shell.notifyOn.length || !shell.conversationId || shell.matchCount >= MAX_WATCH_MATCHES) return ''
  const parts = text.split('\n')
  const rest = parts.pop() ?? ''
  const matched: { pattern: string; line: string }[] = []
  for (const raw of parts) {
    // A progress bar redraws with \r; only its last redraw is the line.
    const line = stripAnsi(raw.slice(raw.lastIndexOf('\r') + 1)).slice(0, MAX_WATCH_LINE)
    const lower = line.toLowerCase()
    const at = shell.notifyOn.findIndex((p) => lower.includes(p))
    if (at < 0) continue
    matched.push({ pattern: shell.notifyOnRaw[at]!, line: line.trim().slice(0, MAX_REPORTED_LINE) })
    if (++shell.matchCount >= MAX_WATCH_MATCHES) break
  }
  const byPattern = new Map<string, string[]>()
  for (const m of matched) byPattern.set(m.pattern, [...(byPattern.get(m.pattern) ?? []), m.line])
  for (const [pattern, lines] of byPattern) {
    const last = lines.slice(-MAX_MATCH_LINES)
    if (shell.matchCount >= MAX_WATCH_MATCHES) last.push(`[stopped watching after ${MAX_WATCH_MATCHES} matching lines]`)
    pushBackgroundEvent(
      shell.conversationId,
      {
        kind: 'shell_match',
        shellId: shell.id,
        command: maskForUi(shell.command),
        pattern,
        lines: last.map(maskForUi),
        dropped: lines.length - Math.min(lines.length, MAX_MATCH_LINES),
        at: Date.now()
      },
      { wake: true }
    )
  }
  return rest.length > MAX_WATCH_LINE ? rest.slice(-MAX_WATCH_LINE) : rest
}

/**
 * Tell the agent's chat that the shell ended. Not when the agent stopped it (kill_shell
 * already said so) or the app is shutting down. A stop by the user or a cancelled turn
 * is reported but never wakes the chat: someone just chose to stop work there.
 */
function reportExit(shell: Shell): void {
  if (!shell.conversationId || shell.stoppedBy === 'agent' || shell.stoppedBy === 'app') return
  const tail = (shellTail(shell.id, EXIT_TAIL_LINES) ?? tailOf(shell)).join('\n')
  pushBackgroundEvent(
    shell.conversationId,
    {
      kind: 'shell_exit',
      shellId: shell.id,
      command: maskForUi(shell.command),
      exitCode: shell.exitCode,
      ...(shell.stoppedBy ? { stoppedBy: shell.stoppedBy } : {}),
      tail: tail.length > EXIT_TAIL_CHARS ? `…${tail.slice(-EXIT_TAIL_CHARS)}` : tail,
      at: Date.now()
    },
    { wake: !shell.stoppedBy }
  )
}

/** {@link shellTail} for a shell not (or no longer) in the registry. */
function tailOf(shell: Shell): string[] {
  return maskForUi(stripAnsi(shell.recent))
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).trimEnd())
    .filter((l) => l.length > 0)
    .slice(-EXIT_TAIL_LINES)
}

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
  const lines = maskForUi(stripAnsi(s.recent))
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
    command: maskForUi(s.command),
    running: s.running,
    ...(s.previewUrls.length ? { url: s.previewUrls[0], urls: [...s.previewUrls] } : {}),
    ...(s.conversationId ? { conversationId: s.conversationId } : {})
  }))
}

/**
 * Longest {@link killAllShells} blocks, after SIGTERMing every shell, for them to stop
 * on their own before it SIGKILLs the rest. Short, because it holds up the quit.
 */
export const QUIT_GRACE_MS = 1_500

/** How often killAllShells re-checks the groups it is waiting on. */
const QUIT_POLL_MS = 50

/** Block the thread for `ms` (only on the way out, where waiting on the event loop isn't an option). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * The given shell pids whose process (or a member of the group it leads) is still
 * running. Read from `ps`, because a signal-0 probe also "finds" a zombie: while
 * killAllShells blocks the event loop, nothing reaps a shell that exited on SIGTERM,
 * so the probe alone would always wait out the whole grace. Falls back to the probe
 * when `ps` can't be run. POSIX only.
 */
function stillRunning(pids: number[]): Set<number> {
  const wanted = new Set(pids)
  const alive = new Set<number>()
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pgid=,pid=,stat='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1_000
    })
    for (const line of out.split('\n')) {
      const [pgid, pid, stat] = line.trim().split(/\s+/)
      if (!stat || stat.startsWith('Z')) continue
      for (const n of [Number(pgid), Number(pid)]) if (wanted.has(n)) alive.add(n)
    }
    return alive
  } catch {
    for (const pid of pids) {
      try {
        process.kill(-pid, 0)
        alive.add(pid)
      } catch {
        try {
          process.kill(pid, 0)
          alive.add(pid)
        } catch {
          // gone
        }
      }
    }
    return alive
  }
}

/**
 * Stop every tracked shell, and any leftovers of exited ones, then clear the registry
 * (wired on app shutdown and on a terminal client's exit). Synchronous, because the
 * quit paths that call it can't wait on the event loop: every group gets SIGTERM, the
 * call blocks up to `graceMs` for them to exit, then SIGKILLs whatever is left.
 * Windows has no graceful group signal, so there every tree is killed at once.
 */
export function killAllShells(opts: { graceMs?: number } = {}): void {
  const graceMs = opts.graceMs ?? QUIT_GRACE_MS
  const live = [...shells.values()].filter((s) => s.running || hasLeftover(s))
  for (const s of shells.values()) {
    s.stoppedBy ??= 'app'
    if (s.stopTimer) clearTimeout(s.stopTimer)
    s.stopTimer = undefined
  }
  if (live.length > 0 && process.platform !== 'win32' && graceMs > 0) {
    for (const s of live) signalProcessTree(s.child, 'SIGTERM')
    const deadline = Date.now() + graceMs
    let pending = live.filter((s) => s.child.pid !== undefined)
    while (pending.length > 0 && Date.now() < deadline) {
      sleepSync(QUIT_POLL_MS)
      const alive = stillRunning(pending.map((s) => s.child.pid as number))
      pending = pending.filter((s) => alive.has(s.child.pid as number))
    }
    // Only what is still running: a group that emptied may already be recycled.
    for (const s of pending) killProcessTree(s.child)
  } else {
    for (const s of live) killProcessTree(s.child)
  }
  shells.clear()
  if (leftoverWatch) {
    clearInterval(leftoverWatch)
    leftoverWatch = null
  }
  writeShellLedger([])
  notifyShellsChanged()
}
