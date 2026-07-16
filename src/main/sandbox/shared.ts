import { spawn, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { DEFAULT_SHELL_OUTPUT_MAX_BYTES } from '@shared/defaults'
import { sanitizeChildEnv } from '../childEnv'
import type {
  SandboxBackend,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSpawnOptions,
  RunSandboxedDeps
} from './contract'

// A foreground command's wall-clock ceiling. Sized so a cold monorepo `npm install`
// (which can run several minutes) completes rather than being guillotined mid-write;
// the model can override per call (run_shell's `timeout_seconds`) and should use a
// background shell for anything genuinely long-running. Kept below the provider/turn
// budget so a wedged command can't stall a whole turn.
export const DEFAULT_TIMEOUT_MS = 300_000
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
 * the agent reaches for via `run_shell` aren't found. Append the standard developer
 * bin dirs (and `~/.local/bin`) that actually exist on disk, without disturbing the
 * precedence of whatever PATH was already inherited.
 *
 * Windows is left untouched: a GUI-launched Windows app inherits the full user PATH
 * from the registry (the macOS minimal-PATH problem doesn't replicate), and the POSIX
 * dirs / `~/.local/bin` are meaningless there. Non-existent candidates are filtered
 * out, so this is harmless on Linux too (Homebrew dirs simply don't exist).
 */
export function augmentPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') return env.PATH ?? ''
  // POSIX-only past this point — the PATH delimiter is ':' (node:path's host-dependent
  // delimiter would be ';' when this runs on a Windows CI host, so use the literal).
  const POSIX_DELIM = ':'
  const candidates = [...EXTRA_PATH_DIRS]
  // POSIX literal (node:path.join would use backslashes when run on a Windows CI host).
  if (env.HOME) candidates.push(`${env.HOME}/.local/bin`)
  const current = (env.PATH ?? '').split(POSIX_DELIM).filter(Boolean)
  const seen = new Set(current)
  const added = candidates.filter((d) => !seen.has(d) && exists(d))
  return [...current, ...added].join(POSIX_DELIM)
}

/**
 * Shared cache dir for package managers, inside the temp area the sandbox makes
 * writable. Package managers default their caches to $HOME (`~/.npm`, `~/.cache`,
 * …), which is OUTSIDE the workspace — so a plain `npm install` fails on the cache
 * *write* (EPERM), not on anything real. Redirecting the cache here lets installs
 * actually succeed (and persists the cache across runs).
 */
export function pkgCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  // `||`, not `??`: an empty-string TMPDIR must fall back to os.tmpdir() too, or
  // join('', …) yields a RELATIVE path that package-manager cache env vars then resolve
  // against the child's cwd (the workspace), polluting the repo and losing persistence.
  return join(env.TMPDIR || tmpdir(), 'houston-pkg-cache')
}

/**
 * Environment for a sandboxed command: the augmented PATH plus package-manager
 * cache redirects into {@link pkgCacheDir}. Only the cache *write* location moves —
 * real HOME config (`~/.npmrc` auth tokens, `~/.gitconfig`) stays readable, since
 * the profile allows reads everywhere. The agent can still override any of these
 * per command (e.g. `npm install --cache …`).
 *
 * Credential-bearing vars (AWS keys, `GH_TOKEN`, `*_API_KEY`, …) are stripped via
 * {@link sanitizeChildEnv} before the spread, so a prompt-injected command can't
 * `env | curl` a secret the user happened to export into the launching shell. The
 * `PATH` we augment and the cache redirects are set explicitly below, so they're
 * unaffected by the strip.
 */
export function sandboxEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cache = pkgCacheDir(baseEnv)
  return {
    ...sanitizeChildEnv(baseEnv),
    PATH: augmentPath(baseEnv),
    npm_config_cache: join(cache, 'npm'),
    YARN_CACHE_FOLDER: join(cache, 'yarn'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    XDG_CACHE_HOME: join(cache, 'xdg'),
    // Go's build + module caches default under $HOME (and `~/Library/Caches/go-build`
    // on macOS, which XDG_CACHE_HOME doesn't cover), so `go build`/`go test`/`go mod`
    // would hit the same write-denial. Redirect both explicitly.
    GOCACHE: join(cache, 'go-build'),
    GOMODCACHE: join(cache, 'go-mod'),
    // Cargo downloads the registry index + crate sources into `~/.cargo`, so
    // `cargo build`/`test`/`fetch` fail on that write under the sandbox. CARGO_HOME
    // is the only redirect lever (there's no separate cache dir); pointing it here
    // fixes the common public-crates.io case. A user relying on `~/.cargo/config.toml`
    // or private-registry credentials there can still set CARGO_HOME per command.
    CARGO_HOME: join(cache, 'cargo'),
    // node-gyp caches the downloaded Node headers/libs it compiles native addons
    // against under `~/.node-gyp` (its "devdir"), so `npm install` of any package
    // with a native build step fails on that write under the sandbox. Redirect the
    // devdir via the npm config env so node-gyp (standalone or via npm) picks it up.
    npm_config_devdir: join(cache, 'node-gyp'),
    // More build toolchains whose caches default under $HOME, so a sandboxed
    // build/install fails on the cache write. Deno and Bun expose a dedicated
    // cache-dir env; Gradle only has GRADLE_USER_HOME (cache + config together), so
    // redirecting it fixes the common case and a user needing `~/.gradle/gradle.
    // properties` can still set it per command.
    GRADLE_USER_HOME: join(cache, 'gradle'),
    DENO_DIR: join(cache, 'deno'),
    BUN_INSTALL_CACHE_DIR: join(cache, 'bun')
  }
}

/** Standard absolute locations a real `bash` lives at, in preference order. `/bin/bash`
 *  is the norm; `/usr/bin/bash` and `/usr/local/bin/bash` cover distros / hand-built
 *  installs where `/bin` isn't the canonical bindir. */
const BASH_PATHS = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash']

/**
 * Resolve a POSIX shell for the agent's bash-flavored commands: a real `bash` from
 * {@link BASH_PATHS}, else POSIX `/bin/sh` as a last resort. `isBash` tells callers
 * whether the bash-only session prelude can run (it can't under plain `/bin/sh`), so
 * `supportsSession` stays honest — the same contract the Windows backend uses for its
 * `cmd.exe` fallback.
 *
 * zsh is deliberately NOT a fallback: the agent's commands are bash-flavored, and zsh's
 * default word-splitting differs from bash (it doesn't split unquoted parameter
 * expansions), so it would silently mis-run commands rather than fail loudly. `/bin/sh`
 * at least executes them with POSIX semantics.
 */
export function resolvePosixShell(exists: (p: string) => boolean = existsSync): {
  shell: string
  isBash: boolean
} {
  const bash = BASH_PATHS.find(exists)
  return bash ? { shell: bash, isBash: true } : { shell: '/bin/sh', isBash: false }
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

export type KillPlan =
  | { kind: 'taskkill'; file: 'taskkill'; args: string[] }
  | { kind: 'group'; target: number }

/**
 * How to reap a process tree on a given platform. Pure so the per-platform branch
 * is unit-testable without spawning real processes.
 *  - POSIX: the child was spawned `detached`, leading its own process group; SIGKILL
 *    the negative pid (`target`) to reap the whole tree (a dev server's children, not
 *    just the bash wrapper).
 *  - Windows: no POSIX process groups; `taskkill /T /F` walks and kills the tree by
 *    parent-pid. `process.kill(-pid)` is invalid on Windows and must NOT be tried.
 */
export function planKill(platform: NodeJS.Platform, pid: number): KillPlan {
  if (platform === 'win32') {
    return { kind: 'taskkill', file: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] }
  }
  return { kind: 'group', target: -pid }
}

/** A single taskkill invocation: an executable plus its arguments. */
export type KillCommand = { file: string; args: string[] }

/**
 * Ordered `taskkill` invocations to try on Windows, most-resilient-PATH-wise last.
 * Every entry reaps the whole tree (`/T /F`) by parent-pid; the caller stops at the
 * first that succeeds. `taskkill` lives in `System32` and is normally on PATH, but a
 * locked-down or stripped PATH (corp images, packaged/headless launches) can hide it —
 * so after the bare name we fall back to its absolute path under `%SystemRoot%`
 * (`%windir%` as an older alias). Only when EVERY tree-kill fails does the caller drop
 * to a shallow `child.kill()`, which can orphan grandchildren.
 */
export function windowsKillCommands(
  pid: number,
  env: NodeJS.ProcessEnv = process.env
): KillCommand[] {
  const args = ['/pid', String(pid), '/T', '/F']
  const cmds: KillCommand[] = [{ file: 'taskkill', args }]
  const root = env.SystemRoot || env.windir
  if (root) cmds.push({ file: win32.join(root, 'System32', 'taskkill.exe'), args })
  return cmds
}

/**
 * Send `signal` to a child and its descendants (see {@link planKill}). SIGTERM asks
 * the tree to shut down cleanly; SIGKILL forces it. On Windows there is no graceful
 * group signal — `taskkill /T /F` is always forceful — so every signal maps to the
 * same tree kill there, and a well-behaved process simply dies on the first call.
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  const plan = planKill(process.platform, pid)
  if (plan.kind === 'taskkill') {
    // Try each taskkill location in turn; the first that reaps the tree wins. Only if
    // they all fail do we fall back to the shallow kill (which leaves grandchildren).
    for (const cmd of windowsKillCommands(pid)) {
      try {
        execFileSync(cmd.file, cmd.args, { stdio: 'ignore' })
        return
      } catch {
        // taskkill missing here or the process already exited — try the next location.
      }
    }
    try {
      child.kill()
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(plan.target, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** SIGKILL a child and its descendants (see {@link planKill}). */
export function killProcessTree(child: ChildProcess): void {
  signalProcessTree(child, 'SIGKILL')
}

/** Grace period after SIGTERM before escalating to SIGKILL on timeout/abort. Long
 *  enough for a package manager or dev server to flush and exit cleanly, short enough
 *  that a wedged process is reaped promptly. */
const KILL_GRACE_MS = 3_000

/** Grace period after the process exits (or is killed) for final stdio to flush
 *  before the call settles. Bounds how long a wedged/orphaned pipe can stall us. */
const STDIO_DRAIN_MS = 250

/**
 * Spawn a backend-wrapped command WITHOUT awaiting it — used for background shells
 * the caller polls later. Same env augmentation as {@link runWithBackend}; the
 * caller owns output capture. Returns the child plus the backend's honest
 * `sandboxed` flag so callers can surface whether the spawn was confined.
 */
export function spawnWithBackend(
  backend: SandboxBackend,
  opts: SandboxSpawnOptions
): { child: ChildProcess; sandboxed: boolean } {
  const launch = backend.buildLaunch({
    command: opts.command,
    roots: opts.roots ?? [opts.workspace],
    allowNetwork: opts.allowNetwork,
    egressProxy: opts.egressProxy,
    cwd: opts.cwd
  })
  const baseEnv = opts.env ?? process.env
  const child = spawn(launch.file, launch.args, {
    cwd: opts.cwd,
    // Launch-specific overrides (proxy env vars, forwarder switches) win over the
    // shared sandbox env — the backend knows how its transport must be addressed.
    env: { ...sandboxEnv(baseEnv), ...launch.env },
    detached: launch.detached,
    windowsHide: launch.windowsHide
  })
  if (opts.signal) {
    const signal = opts.signal
    if (signal.aborted) killProcessTree(child)
    else {
      const onAbort = (): void => killProcessTree(child)
      signal.addEventListener('abort', onAbort, { once: true })
      // Drop the listener once the child exits (as runWithBackend's cleanupAbort does),
      // so a cancel arriving after exit can't SIGKILL a recycled process group, and
      // listeners don't accumulate on the shared per-run signal across background shells.
      child.once('exit', () => signal.removeEventListener('abort', onAbort))
    }
  }
  return { child, sandboxed: backend.sandboxed }
}

/**
 * Run a backend-wrapped command to completion with timeout, both-ends output
 * capping, and whole-tree kill on timeout/abort. The spawn/capture/timeout/drain
 * state machine is identical for every backend; only the argv (via
 * `backend.buildLaunch`) and the honest `sandboxed` flag differ.
 */
export function runWithBackend(
  backend: SandboxBackend,
  opts: SandboxRunOptions,
  deps: RunSandboxedDeps = {}
): Promise<SandboxRunResult> {
  const spawnFn = deps.spawn ?? spawn
  const signalTree = deps.signalTree ?? signalProcessTree
  const killGraceMs = deps.killGraceMs ?? KILL_GRACE_MS
  const drainMs = deps.drainMs ?? STDIO_DRAIN_MS
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const launch = backend.buildLaunch({
    command: opts.command,
    roots: opts.roots ?? [opts.workspace],
    allowNetwork: opts.allowNetwork,
    egressProxy: opts.egressProxy,
    cwd: opts.cwd
  })

  const baseEnv = opts.env ?? process.env

  return new Promise((resolve) => {
    // `detached` (POSIX) puts the command in its own process group so `killTree`
    // can reap the whole tree on timeout/abort. Without it, a kill hits only the
    // wrapper and leaves orphaned grandchildren alive.
    const child = spawnFn(launch.file, launch.args, {
      cwd: opts.cwd,
      env: { ...sandboxEnv(baseEnv), ...launch.env },
      detached: launch.detached,
      windowsHide: launch.windowsHide
    })

    const out = new CappedOutput()
    const err = new CappedOutput()
    let timedOut = false
    let settled = false
    let terminating = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let hardKillTimer: ReturnType<typeof setTimeout> | undefined

    let onAbort: (() => void) | undefined
    const cleanupAbort = (): void => {
      if (onAbort) opts.signal?.removeEventListener('abort', onAbort)
    }

    const settle = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      if (hardKillTimer) clearTimeout(hardKillTimer)
      cleanupAbort()
      resolve({
        stdout: out.toString(),
        stderr: err.toString(),
        exitCode,
        timedOut,
        sandboxed: backend.sandboxed
      })
    }

    // Force settlement even if 'exit'/'close' never fire — e.g. a backgrounded
    // grandchild inherits the stdout/stderr pipe and holds it open, so 'close'
    // (which waits for stdio EOF) would otherwise hang the call forever.
    const armDrain = (exitCode: number | null): void => {
      if (settled || drainTimer) return
      drainTimer = setTimeout(() => settle(exitCode), drainMs)
    }

    // Graceful whole-tree termination on timeout/abort: SIGTERM first so a package
    // manager or dev server can flush and roll back a partial write, then SIGKILL
    // any stragglers that ignore it after a grace period. A well-behaved process
    // exits during the grace window and settles via 'close' before the SIGKILL fires.
    const terminate = (): void => {
      if (terminating || settled) return
      terminating = true
      signalTree(child, 'SIGTERM')
      hardKillTimer = setTimeout(() => {
        signalTree(child, 'SIGKILL')
        armDrain(child.exitCode ?? null)
      }, killGraceMs)
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)

    // Aborting the run (user cancel) terminates the whole tree, same as a timeout.
    if (opts.signal) {
      if (opts.signal.aborted) terminate()
      else {
        onAbort = () => terminate()
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
        sandboxed: backend.sandboxed
      })
    })

    // Settle on 'close' (all stdio drained — the clean, common case). Fall back to
    // a short drain after 'exit' so an orphaned pipe can't keep the call pending.
    child.on('exit', (code) => armDrain(code))
    child.on('close', (code) => settle(code))
  })
}
