import { existsSync } from 'node:fs'
import type { SandboxBackend } from './contract'
import { SeatbeltBackend } from './darwin'
import { UnsandboxedBackend } from './unsandboxed'

/**
 * Choose the confinement backend for the running host, and report — honestly —
 * whether an OS-enforced sandbox is actually available. `sandboxAvailable` probes
 * the real mechanism (not just `process.platform`): on macOS it checks that the
 * `sandbox-exec` binary exists. Linux/Windows return false until their backends
 * land in later phases, so `selectBackend` falls back to the unconfined backend
 * (which reports `sandboxed: false`).
 */

export interface SelectDeps {
  platform?: NodeJS.Platform
  exists?: (p: string) => boolean
}

/** True when an OS-enforced sandbox backend is available and usable on this host. */
export function sandboxAvailable(deps: SelectDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  const exists = deps.exists ?? existsSync
  if (platform === 'darwin') return exists('/usr/bin/sandbox-exec')
  // linux: a later phase flips this to probe `bwrap` + user-namespace capability.
  // win32 / anything else: no enforceable OS sandbox.
  return false
}

/** Pick the confinement backend; falls back to the unconfined backend when none enforces. */
export function selectBackend(deps: SelectDeps = {}): SandboxBackend {
  const platform = deps.platform ?? process.platform
  if (platform === 'darwin' && sandboxAvailable(deps)) return SeatbeltBackend
  // if (platform === 'linux' && sandboxAvailable(deps)) return BubblewrapBackend  // later phase
  return UnsandboxedBackend
}
