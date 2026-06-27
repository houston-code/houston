import type { ChildProcess } from 'node:child_process'
import { selectBackend } from './select'
import { runWithBackend, spawnWithBackend } from './shared'
import type {
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSpawnOptions,
  RunSandboxedDeps
} from './contract'

/**
 * Public sandbox surface. Callers import from `'../sandbox'` (this barrel) exactly
 * as they did when this was a single file — the signatures are unchanged. The host's
 * confinement backend is selected once at module load; the only new, additive
 * exports are `isSandboxed()` (the backend's honest flag) and `spawnSandboxedEx`
 * (spawn that also returns the flag).
 */

export type {
  SandboxRunOptions,
  SandboxRunResult,
  SandboxSpawnOptions,
  RunSandboxedDeps,
  SandboxBackend,
  ShellLaunch
} from './contract'
export {
  CappedOutput,
  clampToolResult,
  augmentPath,
  pkgCacheDir,
  sandboxEnv,
  killProcessTree,
  planKill,
  runWithBackend,
  spawnWithBackend
} from './shared'
export { buildSeatbeltProfile, SeatbeltBackend } from './darwin'
export { UnsandboxedBackend, unsandboxedLaunch } from './unsandboxed'
export { BubblewrapBackend } from './linux'
export { selectBackend, sandboxAvailable } from './select'

/** The confinement backend chosen for this host, resolved once at module load. */
const backend = selectBackend()

/** Run a command under the host's sandbox backend. `result.sandboxed` is honest. */
export function runSandboxed(
  opts: SandboxRunOptions,
  deps: RunSandboxedDeps = {}
): Promise<SandboxRunResult> {
  return runWithBackend(backend, opts, deps)
}

/** Spawn a background command under the host's sandbox backend (no await). */
export function spawnSandboxed(opts: SandboxSpawnOptions): ChildProcess {
  return spawnWithBackend(backend, opts).child
}

/** Spawn a background command, also returning whether the spawn was confined. */
export function spawnSandboxedEx(opts: SandboxSpawnOptions): {
  child: ChildProcess
  sandboxed: boolean
} {
  return spawnWithBackend(backend, opts)
}

/** Whether the active backend enforces an OS sandbox on this host. */
export function isSandboxed(): boolean {
  return backend.sandboxed
}

/** Stable id of the active backend (for startup logging / diagnostics). */
export function activeBackendId(): string {
  return backend.id
}
