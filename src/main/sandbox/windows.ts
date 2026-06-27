import { existsSync } from 'node:fs'
import { win32 } from 'node:path'
import type { SandboxBackend, ShellLaunch } from './contract'

/**
 * Windows backend.
 *
 * Windows has no broadly-available, low-friction kernel mechanism that confines an
 * arbitrary child process's filesystem writes to the workspace the way macOS Seatbelt
 * or Linux bubblewrap do (Job Objects scope lifecycle not files; restricted tokens and
 * AppContainer are coarse and toolchain-hostile; Windows Sandbox is Pro-only and VM-
 * heavy). So `run_shell` runs UNCONFINED here and the backend reports `sandboxed: false`
 * — the approval gate then requires explicit consent (it is never silently auto-approved),
 * and the structured file tools' JS containment still holds on every OS.
 *
 * The agent's commands are bash-flavored, so we prefer a real `bash.exe` (Git for
 * Windows) when present — the existing POSIX command path and session threading work
 * unchanged. Without one we fall back to `cmd.exe`, which can't run the bash session
 * prelude (`supportsSession: false`), so callers route around the session.
 */

export interface WindowsShellDeps {
  env?: NodeJS.ProcessEnv
  exists?: (p: string) => boolean
}

/** Common Git-for-Windows `bash.exe` locations, in preference order. */
function gitBashCandidates(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = []
  const pf = env.ProgramFiles
  const pfx86 = env['ProgramFiles(x86)']
  const local = env.LOCALAPPDATA
  // win32.join keeps backslash separators regardless of the host OS (so this resolves
  // and unit-tests identically on macOS/Linux CI as on a real Windows host).
  if (pf) out.push(win32.join(pf, 'Git', 'bin', 'bash.exe'))
  if (pfx86) out.push(win32.join(pfx86, 'Git', 'bin', 'bash.exe'))
  if (local) out.push(win32.join(local, 'Programs', 'Git', 'bin', 'bash.exe'))
  return out
}

/**
 * Resolve a usable `bash.exe` on Windows, or null (→ cmd.exe fallback). Checks, in
 * order: the `HOUSTON_SHELL` override, then known Git-for-Windows locations. The WSL
 * shim at `System32\bash.exe` is deliberately NOT used — it launches a Linux VM with a
 * translated filesystem, the wrong target for editing Windows-side files.
 */
export function resolveWindowsBash(deps: WindowsShellDeps = {}): string | null {
  const env = deps.env ?? process.env
  const exists = deps.exists ?? existsSync
  const override = env.HOUSTON_SHELL
  if (override && exists(override)) return override
  for (const candidate of gitBashCandidates(env)) {
    if (exists(candidate)) return candidate
  }
  return null
}

/** Pure launch builder for Windows, so the bash-vs-cmd branch is unit-testable. */
export function windowsLaunch(command: string, bashPath: string | null, env: NodeJS.ProcessEnv = process.env): ShellLaunch {
  if (bashPath) {
    // Real bash: the entire POSIX command path + session prelude work unchanged.
    return { file: bashPath, args: ['-c', command], detached: false, windowsHide: true, supportsSession: true }
  }
  // cmd.exe: /d skips AutoRun, /s sanitizes outer-quote handling, /c runs-and-exits.
  const comspec = env.ComSpec || 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/c', command], detached: false, windowsHide: true, supportsSession: false }
}

/**
 * Build the Windows backend, resolving the shell once. `bashPath`/`env`/`exists` are
 * injectable so the backend can be constructed and tested on any host.
 */
export function makeWindowsBackend(deps: WindowsShellDeps & { bashPath?: string | null } = {}): SandboxBackend {
  const bashPath = deps.bashPath !== undefined ? deps.bashPath : resolveWindowsBash(deps)
  const env = deps.env ?? process.env
  return {
    id: 'windows',
    sandboxed: false,
    confinesNetwork: false,
    supportsSession: bashPath !== null,
    buildLaunch({ command }): ShellLaunch {
      return windowsLaunch(command, bashPath, env)
    }
  }
}

/** The Windows backend for the running host (shell resolved at module load). */
export const WindowsBackend: SandboxBackend = makeWindowsBackend()
