import { existsSync } from 'node:fs'
import type { SandboxBackend, ShellLaunch } from './contract'
import { resolvePosixShell } from './shared'

/**
 * Fallback backend for POSIX hosts with no enforceable OS sandbox — i.e. Linux
 * without a usable bubblewrap. The command runs UNCONFINED, so `sandboxed` is false:
 * the honest flag flows to the approval gate and UI, which require explicit consent
 * before any unconfined shell command runs. (Windows has its own backend; see
 * windows.ts.)
 *
 * The shell is resolved via {@link resolvePosixShell} rather than hardcoded — a real
 * `bash` when one exists (the agent's commands are bash-flavored), else POSIX `/bin/sh`
 * so the command still spawns on a minimal host that lacks bash. When it falls back to
 * `/bin/sh`, `supportsSession` is false: the bash session prelude can't run, and callers
 * route around it (same contract as the Windows `cmd.exe` fallback).
 */

/** Pure launch builder so it's trivially unit-testable. Defaults match a bash host. */
export function unsandboxedLaunch(
  command: string,
  shell = '/bin/bash',
  supportsSession = true
): ShellLaunch {
  return { file: shell, args: ['-c', command], detached: true, windowsHide: false, supportsSession }
}

/**
 * Build the unconfined backend, resolving the shell once. `exists` is injectable so the
 * backend can be constructed and tested on any host.
 */
export function makeUnsandboxedBackend(
  exists: (p: string) => boolean = existsSync
): SandboxBackend {
  const { shell, isBash } = resolvePosixShell(exists)
  return {
    id: 'none',
    sandboxed: false,
    confinesNetwork: false,
    supportsSession: isBash,
    buildLaunch({ command }): ShellLaunch {
      return unsandboxedLaunch(command, shell, isBash)
    }
  }
}

/** The unconfined backend for the running host (shell resolved at module load). */
export const UnsandboxedBackend: SandboxBackend = makeUnsandboxedBackend()
