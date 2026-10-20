import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Crash-safe record of the background-shell process groups this Houston process
 * started, so a later launch can stop the ones a crash, force-quit, or signal left
 * running.
 *
 * Background shells are spawned `detached`, so each leads its own process group, and
 * a normal shutdown stops them through killAllShells. An exit that skips that (a
 * crash, a SIGKILL, a force-quit from Activity Monitor) leaves dev servers running
 * under launchd/init, holding their ports for as long as the machine stays up. The
 * next launch then finds the port taken and the server it starts moves elsewhere.
 *
 * Each Houston process writes only its own file, `<pid>-<startedAt>.json`, so several
 * processes sharing one profile (the window plus a TUI) never write the same file, and
 * a launch reaps only files whose owner process is gone.
 *
 * A group is stopped only when one of its live members started inside the window the
 * owner tracked it: at or after the shell's spawn, and no later than the owner's last
 * write. Every write first drops entries whose group has emptied, and the kernel never
 * reuses a process group id while that group still exists, so a group created later
 * under a recycled id has only members younger than the last write and is left alone.
 *
 * POSIX only: Windows has no process groups here and tree-kills by parent pid (see
 * planKill), which an exited parent no longer anchors.
 */

/** One tracked process group. No command text: a command line can carry a secret. */
export interface LedgerEntry {
  pgid: number
  /** Wall-clock ms when the shell was spawned. */
  startedAt: number
}

export interface LedgerFile {
  version: 1
  ownerPid: number
  /** Wall-clock ms when the owning process started. */
  ownerStartedAt: number
  /** Wall-clock ms of the owner's last write. */
  updatedAt: number
  shells: LedgerEntry[]
}

/** A live process as `ps` reports it. `startMs` is truncated to the second. */
export interface ProcRow {
  pid: number
  pgid: number
  startMs: number
}

/**
 * `ps` reports start times to the second, rounded down, while the spawn and owner start
 * times are recorded in ms just after the fact. This much slack on the lower bound
 * absorbs that, and nothing else widens the window.
 */
const START_SLOP_MS = 2_000

const FILE_RE = /^(\d+)-(\d+)\.json$/

const OWNER_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000)

let ledgerDir: string | null = null

function ownFile(dir: string): string {
  return join(dir, `${process.pid}-${OWNER_STARTED_AT}.json`)
}

/** Point the ledger at its directory. Until bound, writes are no-ops (tests, other hosts). */
export function bindShellLedger(dir: string): void {
  ledgerDir = dir
}

/** Test-only: unbind, so a later test starts from a clean, unconfigured state. */
export function resetShellLedger(): void {
  ledgerDir = null
}

/**
 * Replace this process's record with `entries`, or remove the file when there are
 * none. Best effort: a failed write must never break the shell that triggered it.
 */
export function writeShellLedger(entries: LedgerEntry[], platform: NodeJS.Platform = process.platform): void {
  if (!ledgerDir || platform === 'win32') return
  const file = ownFile(ledgerDir)
  try {
    if (entries.length === 0) {
      unlinkSync(file)
      return
    }
    mkdirSync(ledgerDir, { recursive: true, mode: 0o700 })
    const body: LedgerFile = {
      version: 1,
      ownerPid: process.pid,
      ownerStartedAt: OWNER_STARTED_AT,
      updatedAt: Date.now(),
      shells: entries
    }
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
    renameSync(tmp, file)
  } catch {
    // ENOENT on an unlink of a file never written, or a read-only profile: either way
    // the next launch just has less to reap.
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Parse a C-locale `lstart` ("Mon Sep 28 21:34:06 2026") as local time, or NaN. */
export function parseLstart(text: string): number {
  const m = text.trim().match(/^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/)
  if (!m) return NaN
  const month = MONTHS.indexOf(m[1])
  if (month < 0) return NaN
  return new Date(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime()
}

/** Parse `ps -A -o pid=,pgid=,lstart=` output. Rows that don't parse are dropped. */
export function parsePsRows(text: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!m) continue
    const startMs = parseLstart(m[3])
    if (Number.isNaN(startMs)) continue
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), startMs })
  }
  return rows
}

/** Whether a ledger file's owner is still running (same pid AND the same start time). */
export function ownerAlive(file: LedgerFile, rows: ProcRow[]): boolean {
  const owner = rows.find((r) => r.pid === file.ownerPid)
  if (!owner) return false
  // A different process now holding the owner's pid started long after the owner did.
  return Math.abs(owner.startMs - file.ownerStartedAt) <= START_SLOP_MS
}

/** The groups in a dead owner's file that provably still belong to it (see the module doc). */
export function orphanedGroups(file: LedgerFile, rows: ProcRow[]): number[] {
  const out: number[] = []
  for (const entry of file.shells) {
    const owned = rows.some(
      (r) =>
        r.pgid === entry.pgid &&
        r.startMs >= entry.startedAt - START_SLOP_MS &&
        r.startMs <= file.updatedAt
    )
    if (owned && !out.includes(entry.pgid)) out.push(entry.pgid)
  }
  return out
}

function parseLedgerFile(raw: string): LedgerFile | null {
  try {
    const v = JSON.parse(raw) as Partial<LedgerFile>
    if (v.version !== 1) return null
    if (!Number.isInteger(v.ownerPid) || !Number.isFinite(v.ownerStartedAt) || !Number.isFinite(v.updatedAt)) {
      return null
    }
    if (!Array.isArray(v.shells)) return null
    const shells = v.shells.filter(
      (s): s is LedgerEntry =>
        !!s && Number.isInteger(s.pgid) && s.pgid > 1 && Number.isFinite(s.startedAt)
    )
    return { ...(v as LedgerFile), shells }
  } catch {
    return null
  }
}

/** Default process lister: one `ps` call in the C locale so `lstart` parses. */
function listProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-A', '-o', 'pid=,pgid=,lstart='],
      { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parsePsRows(stdout))
    )
  })
}

export interface ReapDeps {
  platform?: NodeJS.Platform
  listProcesses?: () => Promise<ProcRow[]>
  killGroup?: (pgid: number) => void
}

/**
 * Stop the background shells that dead Houston processes left behind, and delete
 * their ledger files. Returns the process group ids it signalled. A file whose owner
 * is still alive is left untouched; a file that can't be parsed is deleted.
 */
export async function reapOrphanedShells(dir: string, deps: ReapDeps = {}): Promise<number[]> {
  if ((deps.platform ?? process.platform) === 'win32') return []
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => FILE_RE.test(n))
  } catch {
    return [] // no ledger directory yet
  }
  const own = `${process.pid}-${OWNER_STARTED_AT}.json`
  names = names.filter((n) => n !== own)
  if (names.length === 0) return []
  const rows = await (deps.listProcesses ?? listProcesses)()
  // An empty listing means `ps` failed: without it nothing can be proven, so keep
  // every file for a later launch rather than deleting what we couldn't check.
  if (rows.length === 0) return []
  const kill =
    deps.killGroup ??
    ((pgid: number) => {
      process.kill(-pgid, 'SIGKILL')
    })
  // Never our own group, whatever a file claims.
  const ownGroup = rows.find((r) => r.pid === process.pid)?.pgid
  const reaped: number[] = []
  for (const name of names) {
    const path = join(dir, name)
    let file: LedgerFile | null
    try {
      file = parseLedgerFile(readFileSync(path, 'utf8'))
    } catch {
      continue // vanished or unreadable mid-scan
    }
    if (file && ownerAlive(file, rows)) continue
    for (const pgid of file ? orphanedGroups(file, rows) : []) {
      if (pgid === ownGroup) continue
      try {
        kill(pgid)
        reaped.push(pgid)
      } catch {
        // ESRCH (already gone) or EPERM (not ours): nothing more to do.
      }
    }
    try {
      unlinkSync(path)
    } catch {
      // another launch removed it first
    }
  }
  return reaped
}

/** The ledger directory inside a profile. */
export function shellLedgerDir(userDataDir: string): string {
  return join(userDataDir, 'background-shells')
}

/**
 * Host startup: bind this process's ledger in the profile and reap what dead Houston
 * processes left behind. Resolves to the process group ids it stopped.
 */
export function startShellLedger(userDataDir: string): Promise<number[]> {
  const dir = shellLedgerDir(userDataDir)
  bindShellLedger(dir)
  return reapOrphanedShells(dir).catch(() => [])
}
