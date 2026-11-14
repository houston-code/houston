import type { ChildProcess } from 'node:child_process'
import { selectBackend, selectBackendAsync } from './select'
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
  DetachedProcess,
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
export { selectBackend, selectBackendAsync, sandboxAvailable } from './select'

/**
 * The confinement backend chosen for this host, resolved once on first use rather than
 * at module load: on Linux selection probes bubblewrap with a synchronous spawn (up to a
 * few seconds), which a process that never runs a command (`houston --help`) should not pay.
 */
let backend: SandboxBackend | undefined

/** Record the chosen backend, logging which confinement this process got. */
function chooseBackend(chosen: SandboxBackend): SandboxBackend {
  backend = chosen
  log.info(`sandbox backend = ${chosen.id} (sandboxed=${chosen.sandboxed})`)
  return chosen
}

function activeBackend(): SandboxBackend {
  // Every client selects here (or in prepareSandbox), so the log names the backend once.
  return backend ?? chooseBackend(selectBackend())
}

let preparing: Promise<void> | undefined

/**
 * Choose the backend without blocking the process, resolving once it is chosen.
 * Selection on first use is synchronous, and on Linux that means a bubblewrap probe
 * spawned synchronously (up to its 3 s timeout) inside whatever first asks. The
 * terminal clients call this at launch and every run awaits it before reading the
 * backend, so the probe runs as an asynchronous spawn instead, alongside their startup
 * and the run's other start-up work. Same answer as the synchronous selection; if the
 * asynchronous path fails in any way, the backend is left unchosen and the first use
 * selects synchronously, exactly as before. Idempotent.
 */
export function prepareSandbox(): Promise<void> {
  if (backend) return Promise.resolve()
  return (preparing ??= selectBackendAsync()
    .then((chosen) => {
      if (!backend) chooseBackend(chosen)
    })
    .catch(() => {}))
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
