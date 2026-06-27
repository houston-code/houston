import type { SandboxBackend, ShellLaunch } from './contract'

/**
 * Fallback backend for POSIX hosts with no enforceable OS sandbox — i.e. Linux
 * without a usable bubblewrap. The command runs UNCONFINED through `/bin/bash`, so
 * `sandboxed` is false: the honest flag flows to the approval gate and UI, which
 * require explicit consent before any unconfined shell command runs. (Windows has its
 * own backend; see windows.ts.)
 */

/** Pure launch builder so it's trivially unit-testable. */
export function unsandboxedLaunch(command: string): ShellLaunch {
  return { file: '/bin/bash', args: ['-c', command], detached: true, windowsHide: false, supportsSession: true }
}

export const UnsandboxedBackend: SandboxBackend = {
  id: 'none',
  sandboxed: false,
  confinesNetwork: false,
  supportsSession: true,
  buildLaunch({ command }): ShellLaunch {
    return unsandboxedLaunch(command)
  }
}
