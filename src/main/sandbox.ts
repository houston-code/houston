import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { DEFAULT_SHELL_OUTPUT_MAX_BYTES } from '@shared/defaults'

/**
 * macOS Seatbelt sandbox for the agent's shell execution.
 *
 * Commands run under `sandbox-exec` with a generated SBPL profile that:
 *   - denies everything by default
 *   - allows reading the filesystem (compilers/tools need system headers, etc.)
 *   - allows writing ONLY inside the workspace and temp directories
 *   - allows or denies network access per the approval policy
 *
 * This is the same OS-native mechanism Codex uses on macOS. It is the boundary
 * for arbitrary shell commands; structured file tools enforce containment in JS.
 */

export interface SandboxRunOptions {
  command: string
  cwd: string
  workspace: string
  /** Extra writable roots beyond the workspace (e.g. added directories). */
  roots?: string[]
  allowNetwork: boolean
  timeoutMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}

export interface SandboxRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  sandboxed: boolean
}

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 1_000_000 // 1 MB cap per stream
// Split the budget across both ends so the command echo / early errors AND the
// trailing summary (e.g. `5 failed, 120 passed`) both survive truncation.
const HEAD_BYTES = Math.floor(MAX_OUTPUT_BYTES / 2)
const TAIL_BYTES = MAX_OUTPUT_BYTES - HEAD_BYTES

/** Standard macOS developer bin dirs, including Homebrew (Apple Silicon + Intel). */
const EXTRA_PATH_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
]

/**
 * A GUI-launched macOS app inherits a minimal PATH (often just
 * `/usr/bin:/bin:/usr/sbin:/sbin`), so Homebrew and other user-installed tools
 * the agent reaches for via `run_shell` aren't found. Append the standard
 * developer bin dirs (and `~/.local/bin`) that actually exist on disk, without
 * disturbing the precedence of whatever PATH was already inherited.
 */
export function augmentPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync
): string {
  const candidates = [...EXTRA_PATH_DIRS]
  if (env.HOME) candidates.push(join(env.HOME, '.local', 'bin'))
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const seen = new Set(current)
  const added = candidates.filter((d) => !seen.has(d) && exists(d))
  return [...current, ...added].join(delimiter)
}

/** Escape a path for safe embedding inside an SBPL double-quoted literal. */
function sbplPath(p: string): string {
  let real = p
  try {
    real = realpathSync(p)
  } catch {
    // Path may not exist yet; fall back to the raw path.
  }
  return real.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildSeatbeltProfile(roots: string | string[], allowNetwork: boolean): string {
  const rootList = (Array.isArray(roots) ? roots : [roots]).filter(Boolean)
  const tmp = sbplPath(tmpdir())
  const writableRoots = rootList.map((r) => `  (subpath "${sbplPath(r)}")`).join('\n')

  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(allow file-write*
${writableRoots}
  (subpath "${tmp}")
  (subpath "/private/tmp")
  (subpath "/private/var/tmp"))
(allow file-write-data
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/dtracehelper")
  (literal "/dev/urandom")
  (literal "/dev/random"))
${allowNetwork ? '(allow network*)' : '; network denied'}
`
}

/** Whether the macOS sandbox-exec binary is present. */
export function sandboxAvailable(): boolean {
  return process.platform === 'darwin'
}

/**
 * Bounded capture that preserves BOTH ends of a stream: the first `head` bytes
 * and the last `tail` bytes, with a `\n[... N bytes truncated ...]\n` marker in
 * between once anything is dropped. Test runners and builds print the most
 * actionable line (the failure summary) last, so a head-only cap throws away
 * exactly what the agent needs; keeping the tail too costs the same budget.
 *
 * The tail is a rolling window over the chunk array — old leading chunks are
 * shifted off (and the boundary chunk sliced) once the tail budget is exceeded,
 * so memory stays bounded regardless of total output size.
 */
export class CappedOutput {
  private readonly headChunks: Buffer[] = []
  private readonly tailChunks: Buffer[] = []
  private headLen = 0
  private tailLen = 0
  private total = 0

  constructor(
    private readonly head: number = HEAD_BYTES,
    private readonly tail: number = TAIL_BYTES
  ) {}

  push(chunk: Buffer): void {
    this.total += chunk.length
    // Fill the head budget first; any overflow flows into the rolling tail.
    if (this.headLen < this.head) {
      const room = this.head - this.headLen
      const forHead = chunk.subarray(0, room)
      this.headChunks.push(forHead)
      this.headLen += forHead.length
      const rest = chunk.subarray(forHead.length)
      if (rest.length > 0) this.pushTail(rest)
    } else {
      this.pushTail(chunk)
    }
  }

  private pushTail(chunk: Buffer): void {
    this.tailChunks.push(chunk)
    this.tailLen += chunk.length
    // Trim whole leading chunks while doing so still leaves the tail budget full.
    while (this.tailChunks.length > 1 && this.tailLen - this.tailChunks[0].length >= this.tail) {
      this.tailLen -= this.tailChunks.shift()!.length
    }
    const overflow = this.tailLen - this.tail
    if (overflow > 0) {
      this.tailChunks[0] = this.tailChunks[0].subarray(overflow)
      this.tailLen -= overflow
    }
  }

  /** Bytes discarded between the retained head and tail (0 if nothing dropped). */
  get droppedBytes(): number {
    return Math.max(0, this.total - this.headLen - this.tailLen)
  }

  toString(): string {
    const head = Buffer.concat(this.headChunks).toString('utf8')
    if (this.droppedBytes === 0) {
      // Nothing dropped: head + tail are contiguous, so concatenation is exact.
      return head + Buffer.concat(this.tailChunks).toString('utf8')
    }
    const tail = Buffer.concat(this.tailChunks).toString('utf8')
    return `${head}\n[... ${this.droppedBytes} bytes truncated ...]\n${tail}`
  }
}

/**
 * Clamp an already-assembled tool-result string to the per-result context budget,
 * preserving both ends with a truncation marker. Reuses `CappedOutput` so the
 * marker format matches what per-stream streaming truncation already produces.
 * Callers pass the user-configured budget; the default is the fallback.
 */
export function clampToolResult(
  text: string,
  maxBytes: number = DEFAULT_SHELL_OUTPUT_MAX_BYTES
): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const head = Math.floor(maxBytes / 2)
  const cap = new CappedOutput(head, maxBytes - head)
  cap.push(Buffer.from(text, 'utf8'))
  return cap.toString()
}

/**
 * SIGKILL a child and its descendants. Background shells are spawned `detached`
 * so the child leads its own process group; killing the negative pid reaps the
 * whole tree (a dev server's child processes, not just the bash wrapper).
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
}

/**
 * Spawn a sandboxed command WITHOUT awaiting it — used for background shells the
 * agent starts and polls later. Same Seatbelt profile and PATH augmentation as
 * `runSandboxed`; the caller owns output capture. Spawned `detached` so the whole
 * process tree can be killed together. If a `signal` is given, aborting it (e.g.
 * the user cancelling the run) kills the tree.
 */
export function spawnSandboxed(opts: {
  command: string
  cwd: string
  workspace: string
  roots?: string[]
  allowNetwork: boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): ChildProcess {
  const profile = buildSeatbeltProfile(opts.roots ?? [opts.workspace], opts.allowNetwork)
  const args = ['-p', profile, '/bin/bash', '-c', opts.command]
  const baseEnv = opts.env ?? process.env
  const child = spawn('sandbox-exec', args, {
    cwd: opts.cwd,
    env: { ...baseEnv, PATH: augmentPath(baseEnv) },
    detached: true
  })
  if (opts.signal) {
    if (opts.signal.aborted) killProcessTree(child)
    else opts.signal.addEventListener('abort', () => killProcessTree(child), { once: true })
  }
  return child
}

/** Grace period after the process exits (or is killed) for final stdio to flush
 *  before the call settles. Bounds how long a wedged/orphaned pipe can stall us. */
const STDIO_DRAIN_MS = 250

/** Injectable seams for `runSandboxed` (real implementations used in production). */
export interface RunSandboxedDeps {
  spawn?: typeof spawn
  killTree?: (child: ChildProcess) => void
  drainMs?: number
}

export function runSandboxed(
  opts: SandboxRunOptions,
  deps: RunSandboxedDeps = {}
): Promise<SandboxRunResult> {
  const spawnFn = deps.spawn ?? spawn
  const killTree = deps.killTree ?? killProcessTree
  const drainMs = deps.drainMs ?? STDIO_DRAIN_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const profile = buildSeatbeltProfile(opts.roots ?? [opts.workspace], opts.allowNetwork)

  // sandbox-exec -p <profile> /bin/bash -c <command>
  const args = ['-p', profile, '/bin/bash', '-c', opts.command]

  const baseEnv = opts.env ?? process.env

  return new Promise((resolve) => {
    // `detached` puts the command in its own process group so `killTree` can reap
    // the whole tree (bash + npm + node + …) on timeout/abort. Without it, a kill
    // hits only the `sandbox-exec` wrapper and leaves orphaned grandchildren alive.
    const child = spawnFn('sandbox-exec', args, {
      cwd: opts.cwd,
      env: { ...baseEnv, PATH: augmentPath(baseEnv) },
      detached: true
    })

    const out = new CappedOutput()
    const err = new CappedOutput()
    let timedOut = false
    let settled = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined

    let onAbort: (() => void) | undefined
    const cleanupAbort = (): void => {
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
    }

    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      cleanupAbort()
      resolve({ stdout: out.toString(), stderr: err.toString(), exitCode, timedOut, sandboxed: true })
    }

    // Force settlement even if 'exit'/'close' never fire — e.g. a backgrounded
    // grandchild inherits the stdout/stderr pipe and holds it open, so 'close'
    // (which waits for stdio EOF) would otherwise hang the call forever.
    const armDrain = (exitCode: number | null): void => {
      if (settled || drainTimer) return
      drainTimer = setTimeout(() => settle(exitCode), drainMs)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
      armDrain(child.exitCode ?? null)
    }, timeoutMs)

    // Aborting the run (user cancel) kills the whole tree, same as a timeout.
    if (opts.signal) {
      if (opts.signal.aborted) killTree(child)
      else {
        onAbort = () => killTree(child)
        opts.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.stderr?.on('data', (c: Buffer) => err.push(c))

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      cleanupAbort()
      resolve({
        stdout: '',
        stderr: `Failed to launch sandboxed process: ${e.message}`,
        exitCode: null,
        timedOut,
        sandboxed: true
      })
    })

    // Settle on 'close' (all stdio drained — the clean, common case). Fall back to
    // a short drain after 'exit' so an orphaned pipe can't keep the call pending.
    child.on('exit', (code) => armDrain(code))
    child.on('close', (code) => settle(code))
  })
}
