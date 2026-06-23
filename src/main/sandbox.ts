import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

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

export function buildSeatbeltProfile(workspace: string, allowNetwork: boolean): string {
  const ws = sbplPath(workspace)
  const tmp = sbplPath(tmpdir())

  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(allow file-write*
  (subpath "${ws}")
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

function appendCapped(buffers: Buffer[], current: number, chunk: Buffer): number {
  if (current >= MAX_OUTPUT_BYTES) return current
  const remaining = MAX_OUTPUT_BYTES - current
  buffers.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
  return current + chunk.length
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
  allowNetwork: boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}): ChildProcess {
  const profile = buildSeatbeltProfile(opts.workspace, opts.allowNetwork)
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

export function runSandboxed(opts: SandboxRunOptions): Promise<SandboxRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const profile = buildSeatbeltProfile(opts.workspace, opts.allowNetwork)

  // sandbox-exec -p <profile> /bin/bash -c <command>
  const args = ['-p', profile, '/bin/bash', '-c', opts.command]

  const baseEnv = opts.env ?? process.env

  return new Promise((resolve) => {
    const child = spawn('sandbox-exec', args, {
      cwd: opts.cwd,
      env: { ...baseEnv, PATH: augmentPath(baseEnv) },
      signal: opts.signal
    })

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outLen = 0
    let errLen = 0
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.on('data', (c: Buffer) => {
      outLen = appendCapped(outChunks, outLen, c)
    })
    child.stderr.on('data', (c: Buffer) => {
      errLen = appendCapped(errChunks, errLen, c)
    })

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer)
      const truncNote =
        outLen > MAX_OUTPUT_BYTES || errLen > MAX_OUTPUT_BYTES ? '\n[output truncated]' : ''
      resolve({
        stdout: Buffer.concat(outChunks).toString('utf8') + (outLen > MAX_OUTPUT_BYTES ? truncNote : ''),
        stderr: Buffer.concat(errChunks).toString('utf8') + (errLen > MAX_OUTPUT_BYTES ? truncNote : ''),
        exitCode,
        timedOut,
        sandboxed: true
      })
    }

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        stdout: '',
        stderr: `Failed to launch sandboxed process: ${err.message}`,
        exitCode: null,
        timedOut,
        sandboxed: true
      })
    })

    child.on('close', (code) => finish(code))
  })
}
