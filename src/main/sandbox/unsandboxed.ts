import type { SandboxBackend, ShellLaunch } from './contract'

/**
 * Fallback backend for hosts with no enforceable OS sandbox (Windows, or Linux
 * without a usable bubblewrap). The command runs UNCONFINED — `sandboxed` is false
 * so the honest flag flows to the approval gate and UI, which then require explicit
 * consent before any unconfined shell command runs (see approval.decideApproval).
 *
 * Windows shell selection is intentionally minimal here (cmd.exe); a later phase
 * refines it (prefer a POSIX shell when available). On POSIX hosts this is `/bin/bash`.
 */

/** Pure launch builder so the per-platform branch is unit-testable. */
export function unsandboxedLaunch(command: string, platform: NodeJS.Platform): ShellLaunch {
  if (platform === 'win32') {
    // No POSIX process groups on Windows: spawn non-detached and reap via taskkill
    // (see planKill). `/d /s /c` disables AutoRun and runs the command string as-is.
    const comspec = process.env.ComSpec || 'cmd.exe'
    return { file: comspec, args: ['/d', '/s', '/c', command], detached: false, windowsHide: true }
  }
  return { file: '/bin/bash', args: ['-c', command], detached: true, windowsHide: false }
}

export const UnsandboxedBackend: SandboxBackend = {
  id: 'none',
  sandboxed: false,
  confinesNetwork: false,
  buildLaunch({ command }): ShellLaunch {
    return unsandboxedLaunch(command, process.platform)
  }
}
