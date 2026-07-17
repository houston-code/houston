import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import type { DoctorFacts } from '@shared/doctor'
import { getSettings } from './store'
import { getUserDataDir } from './userData'
import { getMcpStatuses } from './mcp/manager'
import { activeBackendId, isSandboxed } from './sandbox'
import { providerKeyEnvVars } from '@shared/provider-keys'

/**
 * Resolve a binary on PATH, or null. Absolute `where.exe` on Windows: a bare
 * `where` can resolve from the CWD before PATH, and the CWD is the user's
 * (possibly untrusted) workspace — /doctor must not run a where.exe someone
 * dropped in a cloned repo.
 */
export function findBinary(name: string): string | null {
  try {
    const cmd =
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe')
        : 'which'
    const res = spawnSync(cmd, [name], { encoding: 'utf8' })
    const first = (res.stdout ?? '').split('\n')[0]?.trim()
    return res.status === 0 && first ? first : null
  } catch {
    return null
  }
}

/**
 * Gather the `/doctor` facts common to every client — provider keys (and any env
 * var shadowing them), the sandbox backend, MCP connection state, the binaries the
 * agent shells out to. All of it was already knowable, but only by reading source
 * or guessing; the grading lives in `@shared/doctor` so this stays a fact-gatherer.
 *
 * The `terminal` group is client-specific and NOT set here — the interactive
 * terminal adds it, the desktop app omits it (see `buildDoctorReport`). `version`
 * and `update` are passed in because each host tracks them its own way.
 */
export function gatherDoctorFacts(
  cwd: string,
  opts: { version: string; update: { latest: string; url: string } | null }
): DoctorFacts {
  const s = getSettings()
  const env = process.env
  return {
    version: opts.version,
    nodeVersion: process.version,
    platform: `${process.platform} ${process.arch}`,
    cwd,
    settingsPath: join(getUserDataDir(), 'settings.json'),
    sandbox: { backend: activeBackendId(), enforced: isSandboxed() },
    providers: s.providers.map((p) => {
      // The cause of "I set my key and nothing changed": an env var silently
      // outranks the stored one.
      const shadow = providerKeyEnvVars(p.id).find((v) => env[v])
      return {
        id: p.id,
        requiresKey: Boolean(p.requiresKey),
        hasKey: Boolean(p.hasKey),
        ...(shadow ? { shadowedByEnv: shadow } : {})
      }
    }),
    active: s.selected ? { providerId: s.selected.providerId, model: s.selected.model } : null,
    mcp: getMcpStatuses().map((m) => ({
      id: m.id,
      state: m.state,
      ...(m.state === 'connected'
        ? { detail: `connected, ${m.tools ?? 0} tool${m.tools === 1 ? '' : 's'}` }
        : m.error
          ? { detail: m.error }
          : {})
    })),
    binaries: [
      { name: 'git', path: findBinary('git'), purpose: 'the git tools and worktrees' },
      { name: 'gh', path: findBinary('gh'), purpose: 'the GitHub tools' },
      { name: 'rg', path: findBinary('rg'), purpose: 'faster search_files' }
    ],
    update: opts.update
  }
}
