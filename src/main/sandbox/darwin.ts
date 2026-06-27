import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { SandboxBackend, ShellLaunch } from './contract'

/**
 * macOS Seatbelt backend.
 *
 * Commands run under `sandbox-exec` with a generated SBPL profile that denies
 * everything by default, allows reading the whole filesystem, allows writing only
 * inside the workspace/roots and temp dirs, and gates network per the policy. This
 * is the OS-native sandbox mechanism on macOS.
 */

/** Escape a path for safe embedding inside an SBPL double-quoted literal. */
function sbplPath(p: string): string {
  let real = p
  try {
    real = realpathSync(p)
  } catch {
    // Path may not exist yet; fall back to the raw path.
  }
  return real.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export function buildSeatbeltProfile(roots: string | string[], allowNetwork: boolean): string {
  const rootList = (Array.isArray(roots) ? roots : [roots]).filter(Boolean)
  const tmp = sbplPath(tmpdir())
  const writableRoots = rootList.map((r) => `  (subpath "${sbplPath(r)}")`).join('\n')

  return `(version 1)
(deny default)
(allow process-exec)
(allow process-fork)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(allow file-write*
${writableRoots}
  (subpath "${tmp}")
  (subpath "/private/tmp")
  (subpath "/private/var/tmp"))
(allow file-write-data
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/dtracehelper")
  (literal "/dev/urandom")
  (literal "/dev/random"))
${allowNetwork ? '(allow network*)' : '; network denied'}
`
}

export const SeatbeltBackend: SandboxBackend = {
  id: 'seatbelt',
  sandboxed: true,
  confinesNetwork: true,
  buildLaunch({ command, roots, allowNetwork }): ShellLaunch {
    const profile = buildSeatbeltProfile(roots, allowNetwork)
    return {
      file: 'sandbox-exec',
      args: ['-p', profile, '/bin/bash', '-c', command],
      detached: true,
      windowsHide: false
    }
  }
}
