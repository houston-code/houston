import type { ChildProcess } from 'node:child_process'
import { selectBackend } from './select'
import { log } from '../logger'
import { runWithBackend, spawnWithBackend } from './shared'
import type {
  SandboxBackend,
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSpawnOptions,
  RunSandboxedDeps,
  ShellSyntax
} from './contract'

/**
 * Public sandbox surface. Callers import from `'../sandbox'` (this barrel) exactly
 * as they did when this was a single file — the signatures are unchanged. The host's
 * confinement backend is selected once, on first use (see `activeBackend`); the only new, additive
 * exports are `isSandboxed()` (the backend's honest flag) and `spawnSandboxedEx`
 * (spawn that also returns the flag).
 */

export type {
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSpawnOptions,
  RunSandboxedDeps,
  SandboxBackend,
  ShellLaunch,
  ShellSyntax,
  EgressProxyEndpoints
} from './contract'
export {
  startEgressProxy,
  egressProxyEnv,
  EGRESS_BLOCKED_MARKER,
  EGRESS_PROXY_INNER_PORT
} from './egress-proxy'
export type {
  EgressCheck,
  EgressLogEvent,
  EgressProxyHandle,
  StartEgressProxyOptions
} from './egress-proxy'
export {
  CappedOutput,
  clampToolResult,
  augmentPath,
  pkgCacheDir,
  sandboxEnv,
  OFFLINE_FAIL_FAST_ENV,
  killProcessTree,
  KILL_GRACE_MS,
  signalProcessTree,
  planKill,
  runWithBackend,
  spawnWithBackend,
  DEFAULT_TIMEOUT_MS
} from './shared'
export { buildSeatbeltProfile, SeatbeltBackend } from './darwin'
export { UnsandboxedBackend, unsandboxedLaunch } from './unsandboxed'
export { BubblewrapBackend } from './linux'
export { WindowsBackend, makeWindowsBackend, resolveWindowsBash, windowsLaunch } from './windows'
export { selectBackend, sandboxAvailable } from './select'

/**
 * The confinement backend chosen for this host, resolved once on first use rather than
 * at module load: on Linux selection probes bubblewrap with a synchronous spawn (up to a
 * few seconds), which a process that never runs a command (`houston --help`) should not pay.
 */
let backend: SandboxBackend | undefined

function activeBackend(): SandboxBackend {
  if (!backend) {
    backend = selectBackend()
    // Every client selects here, so the log says which confinement this process got.
    log.info(`sandbox backend = ${backend.id} (sandboxed=${backend.sandboxed})`)
  }
  return backend
}

/** Run a command under the host's sandbox backend. `result.sandboxed` is honest. */
export function runSandboxed(
  opts: SandboxRunOptions,
  deps: RunSandboxedDeps = {}
): Promise<SandboxRunResult> {
  return runWithBackend(activeBackend(), opts, deps)
}

/** Spawn a background command under the host's sandbox backend (no await). */
export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
  return spawnWithBackend(activeBackend(), opts).child
}

/** Spawn a background command, also returning whether the spawn was confined. */
export function spawnSandboxedEx(opts: SandboxSpawnOptions): {
  child: ChildProcess
  sandboxed: boolean
} {
  return spawnWithBackend(activeBackend(), opts)
}

/** Whether the active backend enforces an OS sandbox on this host. */
export function isSandboxed(): boolean {
  return activeBackend().sandboxed
}

/** Whether the active backend's shell supports the bash session prelude (cmd.exe → false). */
export function backendSupportsSession(): boolean {
  return activeBackend().supportsSession
}

/** How the active backend's shell parses a command string (cmd.exe fallback → 'cmd'). */
export function backendShellSyntax(): ShellSyntax {
  return activeBackend().shellSyntax
}

/** Stable id of the active backend (for startup logging / diagnostics). */
export function activeBackendId(): string {
  return activeBackend().id
}
