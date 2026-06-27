import type { ChildProcess, spawn } from 'node:child_process'

/**
 * The cross-platform sandbox contract.
 *
 * The agent's arbitrary shell execution (`run_shell`, hooks, auto-format) runs
 * through a per-host {@link SandboxBackend}. Each backend wraps a command so that,
 * on platforms that can enforce it, the command:
 *   - denies everything by default,
 *   - may READ the whole filesystem (compilers/tools need system headers, etc.),
 *   - may WRITE only inside the workspace, extra roots, and temp directories,
 *   - has network access gated by the approval policy,
 *   - may fork/exec children, and is killed as a whole tree on timeout/abort.
 *
 * macOS enforces this natively (Seatbelt). Where no OS mechanism can enforce it,
 * the backend reports `sandboxed: false` and the command runs UNCONFINED — the
 * boundary then reduces to the JS file-tool containment plus the approval gate,
 * and the honest flag flows all the way to the approval decision and the UI so
 * unconfined execution is never silently treated as if it were sandboxed.
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
  /**
   * True ONLY when the active backend enforced OS-level confinement for this run.
   * False means the command ran unconfined (no enforceable sandbox on this host).
   */
  sandboxed: boolean
}

/** Launch a command WITHOUT awaiting it (background shells the caller polls). */
export interface SandboxSpawnOptions {
  command: string
  cwd: string
  workspace: string
  roots?: string[]
  allowNetwork: boolean
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
}

/** Injectable seams for the shared runner (real implementations in production). */
export interface RunSandboxedDeps {
  spawn?: typeof spawn
  killTree?: (child: ChildProcess) => void
  drainMs?: number
}

/**
 * How to launch one command. The shared runner spawns `file` with `args` and
 * handles capture/timeout/drain/kill identically for every backend — the backend
 * only decides HOW the command is wrapped (sandbox-exec, bubblewrap, or bare) and
 * the spawn flags that match that platform.
 */
export interface ShellLaunch {
  /** Executable to spawn, e.g. 'sandbox-exec' | 'bwrap' | '/bin/bash' | 'cmd.exe'. */
  file: string
  /** Full argv after `file`. */
  args: string[]
  /**
   * Spawn `detached` so the child leads its own process group and the whole tree
   * is killable together. True on POSIX; false on Windows (no POSIX process groups
   * — the tree is reaped with taskkill instead, see planKill).
   */
  detached: boolean
  /** Hide the spawned console window on Windows (no-op elsewhere). */
  windowsHide: boolean
  /**
   * Whether this launch can run the bash session prelude (`cd`/env threading across
   * run_shell calls). True for bash-family shells; false for cmd.exe, where the
   * POSIX prelude can't run — callers route around the session then.
   */
  supportsSession: boolean
}

/**
 * A platform confinement strategy. Exactly one is selected per host (see select.ts).
 * `sandboxed` is the source of truth for honesty: a backend that cannot enforce the
 * OS boundary sets it false, and every result it produces carries that false through.
 */
export interface SandboxBackend {
  /** Stable id for logs/UI/tests. */
  readonly id: 'seatbelt' | 'bubblewrap' | 'windows' | 'none'
  /** Whether this backend actually confines the filesystem on this host. */
  readonly sandboxed: boolean
  /** Whether this backend can enforce the `allowNetwork: false` network gate. */
  readonly confinesNetwork: boolean
  /** Whether this backend's shell supports the bash session prelude (see ShellLaunch). */
  readonly supportsSession: boolean
  /**
   * Build the argv + spawn flags to launch `command` under this backend. `cwd` is the
   * working directory (some backends, e.g. bubblewrap, must set it inside the sandbox);
   * the shared runner also passes it to `spawn`, so backends that don't need it ignore it.
   */
  buildLaunch(opts: {
    command: string
    roots: string[]
    allowNetwork: boolean
    cwd: string
  }): ShellLaunch
}
