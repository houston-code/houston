import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type BigIntStats
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Containment-preserving writes for the file tools (write_file, edit_file, multi_edit,
 * notebook_edit, apply_patch and its rollback, and the checkpoint / Changes-view
 * restores).
 *
 * WHY this exists. Those tools run in the main process, OUTSIDE the shell sandbox, and
 * their only confinement is a containment check on a path STRING (`resolveInRoots`).
 * They used to check once and then, several awaits later, hand the same string to
 * plain `fs.writeFile` / `fs.mkdir` / `fs.rm` / `fs.chmod`, which resolve the path
 * again from scratch. A sandboxed background shell is allowed to create symlinks inside
 * the workspace, so it could swap a directory on the path (`sub`) for a symlink to, say,
 * `~/Library/LaunchAgents` in that gap, and the unsandboxed write landed outside the
 * workspace. A probe won that race in under a second.
 *
 * WHAT changes. Every operation here re-derives containment itself, at the moment it
 * acts, and never trusts a string checked earlier:
 *
 *  - Parent directories are created ONE component at a time, starting from the
 *    canonical (realpath) form of the deepest existing ancestor, and each component is
 *    re-checked after it is made: a real directory, or a symlink whose canonical target
 *    is still inside the roots.
 *  - The final component is opened with O_NOFOLLOW inside that canonical parent, so a
 *    symlink swapped in at the file itself fails the open instead of redirecting it.
 *    An in-root symlink that was already there when the call started is followed
 *    explicitly (its target is re-run through the same checks), which keeps the old
 *    "a link inside the project is a normal file" behavior.
 *  - After the open, and BEFORE any byte is written, the fd is verified: the parent's
 *    realpath must still be the canonical in-root directory, and the (dev, ino) of the
 *    fd must match an lstat of the in-root path. Only then is the file truncated and
 *    written, through the fd. A swap that redirected the open is therefore caught with
 *    nothing written and nothing truncated (an existing file is opened WITHOUT O_TRUNC
 *    and only truncated through the fd once it is known to be the right file). Writing
 *    through a verified fd is immune to any later swap: no path is resolved again.
 *  - Modes are applied with fchmod on that same fd, never with a path chmod.
 *  - Removal (unlink of a file, rmdir of an empty directory) lstat-checks the target,
 *    refuses a parent that no longer resolves inside the roots, and acts on the
 *    canonical path. A symlink at the target is removed as a link, never followed.
 *
 * The critical sections are synchronous on purpose: an await between the last check
 * and the syscall hands the attacker a thread-pool round trip for free.
 *
 * RESIDUALS (documented in docs/sandboxing.md). Node exposes no openat/unlinkat, so a
 * path-based step still resolves its directory components again:
 *  - A swap timed between our last check and the open can make an O_EXCL create land
 *    an EMPTY file outside (or a mkdir an empty directory). The fd check then refuses
 *    to write to it and the empty file is unlinked again; only a second swap back,
 *    inside the next few microseconds, can strand it. File CONTENTS reach a file only
 *    after the fd is verified. On Linux that check reads the fd's real location from
 *    /proc/self/fd and is authoritative; on macOS it compares the fd against the path
 *    between two parent realpaths, so defeating it takes several swaps landed within
 *    microseconds of each other, in order.
 *  - unlink/rmdir resolve the parent once more after the check, so a swap timed inside
 *    that window could remove a same-named file elsewhere.
 *  - Windows has no O_NOFOLLOW; there the lstat/realpath re-checks and the fd identity
 *    check still run, but the open itself can follow a reparse point planted in the
 *    window. Windows shells are unconfined anyway (they prompt for every command), so a
 *    racing shell there already has the user's full write access.
 */

/** O_NOFOLLOW where the platform has it (not Windows, where it is undefined). */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

/** How many symlinks a final component may chain through before we give up (as ELOOP). */
const MAX_LINK_HOPS = 40

/** Size of each write(2) when draining a buffer into the fd. */
const WRITE_CHUNK = 1024 * 1024

/** What every operation calls first, before any of its own checks. Tests only. */
type RaceHook = (op: 'write' | 'open' | 'remove' | 'rmdir', abs: string) => void
let raceHook: RaceHook | null = null

/**
 * Test seam: run `fn` at the start of every contained operation (`write`, `remove`,
 * `rmdir`), AFTER the tool's own containment check has passed and before this module
 * does anything, and once more (`open`) right before the final open, after this
 * module's own checks. A test swaps a directory or the file for a symlink there to
 * reproduce the check-then-write race deterministically at either point.
 */
export function setContainedWriteRaceHookForTests(fn: RaceHook | null): void {
  raceHook = fn
}

/** The refusal every containment failure here surfaces. Mentions "symlink" on purpose. */
function escapeError(display: string): Error {
  return new Error(
    `Path escapes the allowed roots via a symlink: ${display}. A folder on the path was replaced by a symlink to somewhere outside the project, so nothing was written.`
  )
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${message}`) as NodeJS.ErrnoException
  e.code = code
  return e
}

/** Whether `abs` is `root` itself or lives inside it (both canonical). */
function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function canonicalRoots(roots: string[]): string[] {
  if (roots.length === 0) throw new Error('No allowed roots configured.')
  return roots.map((r) => {
    try {
      return realpathSync(r)
    } catch {
      return resolve(r)
    }
  })
}

function withinAny(realRoots: string[], p: string): boolean {
  return realRoots.some((root) => isWithin(root, p))
}

function lstatOrNull(p: string): BigIntStats | null {
  try {
    return lstatSync(p, { bigint: true })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/**
 * The canonical form of an existing directory, required to be inside the roots and to
 * be a directory. Throws the escape error when it resolves outside.
 */
function canonicalDir(realRoots: string[], dir: string, display: string): string {
  const real = realpathSync(dir)
  if (!withinAny(realRoots, real)) throw escapeError(display)
  if (!lstatSync(real).isDirectory()) throw errnoError('ENOTDIR', `not a directory: ${display}`)
  return real
}

/**
 * Make sure `dir` exists as a directory inside the roots and return its canonical path.
 * Missing components are created one at a time (never `mkdir -p`, which would follow a
 * symlink swapped in at any level), each re-checked right after; every directory this
 * call created is appended to `created`, shallowest first.
 */
function ensureDir(
  realRoots: string[],
  dir: string,
  create: boolean,
  created: string[] | undefined,
  display: string
): string {
  const missing: string[] = []
  let probe = resolve(dir)
  // lstat, not stat: a dangling symlink exists (and realpath below refuses it), while a
  // genuinely missing component is one we may create.
  while (lstatOrNull(probe) === null) {
    const parent = dirname(probe)
    if (parent === probe) throw errnoError('ENOENT', `no such directory: ${display}`)
    missing.unshift(basename(probe))
    probe = parent
  }
  let base = canonicalDir(realRoots, probe, display)
  for (const name of missing) {
    if (!create) throw errnoError('ENOENT', `no such directory: ${display}`)
    const next = join(base, name)
    let made = false
    try {
      mkdirSync(next)
      made = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Something else made it first; the checks below decide whether we may use it.
    }
    // Re-derive from scratch rather than trusting `next`: a parent swapped since the
    // last check would put `next` (and anything under it) outside the roots.
    const real = canonicalDir(realRoots, next, display)
    if (made && real === next) created?.push(next)
    base = real
  }
  return base
}

interface Target {
  /** Canonical, in-root parent directory. */
  dir: string
  /** `dir` joined with the final component (the final component itself may not exist). */
  path: string
  /** lstat of `path` at resolution time, or null when it does not exist. */
  existing: BigIntStats | null
}

/**
 * Resolve `abs` to a canonical in-root parent plus a final component that is not a
 * symlink. An in-root symlink at the final component is followed by re-running these
 * checks on its target (`symlink: 'follow'`), so a link inside the project still writes its
 * target, while one pointing outside is refused exactly like a symlinked folder.
 * `'refuse'` rejects a symlinked file outright; `'keep'` returns the link itself (to
 * remove it as a link).
 */
function resolveTarget(
  realRoots: string[],
  abs: string,
  opts: { create: boolean; symlink: 'follow' | 'refuse' | 'keep'; created?: string[]; display: string }
): Target {
  let current = resolve(abs)
  let create = opts.create
  for (let hop = 0; hop <= MAX_LINK_HOPS; hop++) {
    const dir = ensureDir(realRoots, dirname(current), create, opts.created, opts.display)
    const path = join(dir, basename(current))
    const existing = lstatOrNull(path)
    if (existing?.isSymbolicLink() && opts.symlink !== 'keep') {
      if (opts.symlink === 'refuse') {
        throw new Error(`Refusing to write ${opts.display}: it is a symlink.`)
      }
      current = resolve(dir, readlinkSync(path))
      // A link's target directory is never created on its behalf (as before, when the
      // write followed the link and failed if its folder was missing).
      create = false
      continue
    }
    return { dir, path, existing }
  }
  throw errnoError('ELOOP', `too many symlinks: ${opts.display}`)
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Prove that `fd` is the file at `target.path` inside the canonical in-root directory,
 * right now. Throws the escape error (after which the caller writes nothing) when the
 * open was redirected.
 */
function verifyFd(realRoots: string[], target: Target, fd: number, display: string): void {
  const fdStat = fstatSync(fd, { bigint: true })
  if (!fdStat.isFile()) throw errnoError('EISDIR', `not a regular file: ${display}`)
  // Parent first, then the entry, then the parent again: an attacker has to have the
  // path in the right state at all three instants, microseconds apart.
  const before = safeRealpath(target.dir)
  const entry = lstatOrNull(target.path)
  const after = safeRealpath(target.dir)
  if (before !== target.dir || after !== target.dir || !entry || !sameFile(entry, fdStat)) {
    throw escapeError(display)
  }
  // Linux names the fd's actual location: authoritative, whatever the path does next.
  if (process.platform === 'linux') {
    let real: string | null = null
    try {
      real = readlinkSync(`/proc/self/fd/${fd}`)
    } catch {
      // No /proc (a minimal container): the checks above stand alone.
    }
    if (real !== null && !withinAny(realRoots, real)) throw escapeError(display)
  }
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function writeAll(fd: number, data: Buffer): void {
  let off = 0
  while (off < data.length) {
    off += writeSync(fd, data, off, Math.min(WRITE_CHUNK, data.length - off))
  }
}

export interface ContainedWriteOptions {
  /** The path as the caller knows it (relative, usually), for error messages. */
  display?: string
  /** Permission bits to set on the file (an exec bit carried across a move, a snapshot's mode). */
  mode?: number
  /** Create missing parent directories (default true). */
  createDirs?: boolean
  /**
   * Follow a symlink already at the final component when its target is inside the
   * roots (default true, the file tools' long-standing behavior). False refuses any
   * symlinked file outright (the rewind / Changes-view restores).
   */
  followSymlink?: boolean
  /** Receives every directory this write created, shallowest first (for a rollback). */
  createdDirs?: string[]
}

/**
 * Write `data` to `abs`, guaranteeing that the bytes land in a regular file inside
 * `roots` even if a symlink is swapped onto the path while the call runs. Throws (with
 * nothing written) when the path resolves outside the roots, or when a swap is detected.
 * An existing file keeps its inode, mode and hard links, as with a plain write.
 */
export function writeFileContained(
  roots: string[],
  abs: string,
  data: string | Buffer,
  opts: ContainedWriteOptions = {}
): void {
  raceHook?.('write', abs)
  const display = opts.display ?? abs
  const realRoots = canonicalRoots(roots)
  const target = resolveTarget(realRoots, abs, {
    create: opts.createDirs !== false,
    symlink: opts.followSymlink === false ? 'refuse' : 'follow',
    created: opts.createdDirs,
    display
  })
  if (target.existing?.isDirectory()) {
    throw errnoError('EISDIR', `illegal operation on a directory, open '${display}'`)
  }
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  // Existing file: open it WITHOUT O_TRUNC, so a redirected open damages nothing; it is
  // truncated through the fd only once verified. A missing one is created with O_EXCL,
  // which also refuses to follow anything that appeared at the name since.
  const flags = target.existing
    ? fsConstants.O_WRONLY | O_NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW
  let fd: number
  raceHook?.('open', target.path)
  try {
    fd = openSync(target.path, flags, 0o666)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // O_NOFOLLOW on a symlink fails with ELOOP (EMLINK on some BSDs); O_EXCL on one
    // with EEXIST. Either way something was swapped in at the file itself.
    if (code === 'ELOOP' || code === 'EMLINK') throw escapeError(display)
    if (code === 'EEXIST' && lstatOrNull(target.path)?.isSymbolicLink()) throw escapeError(display)
    throw e
  }
  let created: BigIntStats | null = null
  try {
    if (!target.existing) created = fstatSync(fd, { bigint: true })
    verifyFd(realRoots, target, fd, display)
    created = null // verified: from here on it is the caller's file, whatever happens
    if (target.existing) ftruncateSync(fd, 0)
    writeAll(fd, bytes)
    if (opts.mode !== undefined) fchmodSync(fd, opts.mode & 0o7777)
  } finally {
    closeSync(fd)
    // A file this call created and then refused to write to (the open was redirected)
    // is removed again, wherever it landed, as long as the name still refers to that
    // same empty inode. Nothing of value can go with it.
    if (created) {
      try {
        const entry = lstatOrNull(target.path)
        if (entry && entry.isFile() && entry.size === 0n && sameFile(entry, created)) unlinkSync(target.path)
      } catch {
        // Best effort: the refusal itself is what matters.
      }
    }
  }
}

/**
 * Remove the file (or symlink, as a link) at `abs`. A missing file, or a missing parent,
 * is not an error (like `rm -f`). Refuses a directory, and a parent that no longer
 * resolves inside the roots.
 */
export function removeFileContained(roots: string[], abs: string, opts: { display?: string } = {}): void {
  raceHook?.('remove', abs)
  const display = opts.display ?? abs
  const realRoots = canonicalRoots(roots)
  let target: Target
  try {
    target = resolveTarget(realRoots, abs, { create: false, symlink: 'keep', display })
  } catch (e) {
    // A missing parent means there is nothing to remove.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
    throw e
  }
  if (!target.existing) return
  if (target.existing.isDirectory()) throw errnoError('EISDIR', `is a directory: ${display}`)
  if (safeRealpath(target.dir) !== target.dir) throw escapeError(display)
  try {
    unlinkSync(target.path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

/**
 * Remove `dir` if it is an empty, real (not symlinked) directory inside the roots.
 * Returns whether it was removed; a non-empty or missing directory is left alone.
 */
export function removeEmptyDirContained(roots: string[], dir: string): boolean {
  raceHook?.('rmdir', dir)
  const realRoots = canonicalRoots(roots)
  const abs = resolve(dir)
  const parent = safeRealpath(dirname(abs))
  if (parent === null || !withinAny(realRoots, parent)) return false
  const path = join(parent, basename(abs))
  // Never a root itself.
  if (realRoots.includes(path)) return false
  const st = lstatOrNull(path)
  if (!st || !st.isDirectory()) return false
  if (safeRealpath(dirname(abs)) !== parent) return false
  try {
    rmdirSync(path)
    return true
  } catch {
    return false
  }
}
