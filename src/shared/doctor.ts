/**
 * `/doctor`: the "why isn't this working" report — the graded facts, shared by the
 * terminal (which paints them, see `tui-doctor.ts`) and the desktop app (which
 * renders them in a panel). Pure: the host gathers the facts (probing binaries,
 * reading settings) and this grades them, so the report is unit-testable without a
 * machine to probe and identical across clients.
 */

/** One checked thing. `warn` is "works, but you should know"; `fail` is broken. */
export interface DoctorCheck {
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  /** What to do about it — shown only for warn/fail. */
  fix?: string
}

export interface DoctorReport {
  groups: { title: string; checks: DoctorCheck[] }[]
}

/** The facts the host probes for; kept as data so `buildDoctorReport` stays pure. */
export interface DoctorFacts {
  version: string
  nodeVersion: string
  platform: string
  cwd: string
  settingsPath: string
  /** OS sandbox backend id, and whether it actually confines. */
  sandbox: { backend: string; enforced: boolean }
  /** Configured providers: does each have a usable key, and is an env var overriding it? */
  providers: { id: string; requiresKey: boolean; hasKey: boolean; shadowedByEnv?: string }[]
  /** The provider/model this session is running. */
  active: { providerId: string; model: string } | null
  mcp: { id: string; state: 'connected' | 'needs-auth' | 'error' | 'idle'; detail?: string }[]
  /** External binaries the agent shells out to. */
  binaries: { name: string; path: string | null; purpose: string }[]
  /**
   * Terminal capabilities — only meaningful for the interactive terminal client.
   * Absent for the desktop app, whose report simply omits the Terminal group.
   */
  terminal?: { tty: boolean; color: boolean; columns: number; term: string }
  /** Newer release, when the update check found one. */
  update: { latest: string; url: string } | null
  /**
   * Language servers Houston can drive: whether each is installed and whether the
   * workspace looks like it uses that language. Absent on hosts that don't probe them.
   */
  languageServers?: {
    id: string
    name: string
    path: string | null
    source?: string
    usedByProject: boolean
    installHint: string
  }[]
  /** Why installed servers won't start here, if they won't (see IntegrationsInfo). */
  languageServersBlocked?: 'disabled' | 'unsandboxed' | 'needs-git-bash'
}

/** The "Language servers" group: installed servers, missing ones this project needs, and a blocked host. */
function languageServerChecks(f: DoctorFacts): DoctorCheck[] {
  const servers = f.languageServers ?? []
  const checks: DoctorCheck[] = []
  if (f.languageServersBlocked) {
    const why = {
      disabled: { detail: 'turned off (in settings, or by HOUSTON_LSP=off)', fix: 'turn language servers on in Settings > Tools' },
      unsandboxed: {
        detail: 'off: no OS sandbox on this host to confine them',
        fix: 'turn them on explicitly in Settings > Tools if you accept running them unconfined'
      },
      'needs-git-bash': { detail: 'off: they need Git for Windows (Git Bash)', fix: 'install Git for Windows, then restart Houston' }
    }[f.languageServersBlocked]
    checks.push({ label: 'language servers', status: 'warn', ...why })
  }
  const missing: string[] = []
  for (const s of servers) {
    if (s.path) {
      checks.push({ label: s.id, status: 'ok', detail: s.source === 'workspace' ? `${s.path} (project)` : s.path })
    } else if (s.usedByProject) {
      checks.push({
        label: s.id,
        status: 'warn',
        detail: `not installed; this project uses ${s.name}`,
        fix: s.installHint
      })
    } else {
      missing.push(s.id)
    }
  }
  if (missing.length) checks.push({ label: 'not installed', status: 'ok', detail: `${missing.join(', ')} (optional)` })
  return checks
}

/** Turn probed facts into the graded report. Pure. */
export function buildDoctorReport(f: DoctorFacts): DoctorReport {
  const providerChecks: DoctorCheck[] = f.providers.map((p) => {
    if (!p.requiresKey) return { label: p.id, status: 'ok', detail: 'no key needed' }
    if (!p.hasKey) {
      return { label: p.id, status: 'warn', detail: 'no API key', fix: `run /login and pick ${p.id}` }
    }
    if (p.shadowedByEnv) {
      // Not broken, but the cause of "I changed my key and nothing happened".
      return {
        label: p.id,
        status: 'warn',
        detail: `key set, but ${p.shadowedByEnv} in your environment takes precedence`,
        fix: `unset ${p.shadowedByEnv} to use the stored key`
      }
    }
    return { label: p.id, status: 'ok', detail: 'key set' }
  })
  if (!f.providers.length) {
    providerChecks.push({
      label: 'providers',
      status: 'fail',
      detail: 'none configured',
      fix: 'run /login to add one'
    })
  } else if (!f.active) {
    providerChecks.push({
      label: 'active model',
      status: 'fail',
      detail: 'none selected',
      fix: 'run /login, or /model <id>'
    })
  }

  const groups: DoctorReport['groups'] = [
    {
      title: 'Houston',
      checks: [
        {
          label: 'version',
          status: f.update ? 'warn' : 'ok',
          detail: f.update ? `${f.version} (${f.update.latest} available)` : f.version,
          ...(f.update ? { fix: `download it at ${f.update.url}` } : {})
        },
        { label: 'node', status: 'ok', detail: f.nodeVersion },
        { label: 'platform', status: 'ok', detail: f.platform },
        { label: 'settings', status: 'ok', detail: f.settingsPath },
        { label: 'workspace', status: 'ok', detail: f.cwd }
      ]
    },
    {
      title: 'Model',
      checks: [
        ...(f.active
          ? [{ label: 'active', status: 'ok' as const, detail: `${f.active.providerId} / ${f.active.model}` }]
          : []),
        ...providerChecks
      ]
    },
    {
      title: 'Sandbox',
      checks: [
        f.sandbox.enforced
          ? { label: 'shell sandbox', status: 'ok', detail: `enforced (${f.sandbox.backend})` }
          : {
              // Honest, not reassuring: commands really do run unconfined here.
              label: 'shell sandbox',
              status: 'warn',
              detail: `NOT enforced on this host (${f.sandbox.backend})`,
              fix: 'shell commands run unconfined; approve them with that in mind'
            }
      ]
    },
    {
      title: 'Tools',
      checks: f.binaries.map((b) => ({
        label: b.name,
        status: b.path ? 'ok' : 'warn',
        detail: b.path ?? 'not found on PATH',
        ...(b.path ? {} : { fix: `install it to use ${b.purpose}` })
      }))
    },
    // Only on hosts that probe language servers, so a report without them is unchanged.
    ...(f.languageServers || f.languageServersBlocked
      ? [{ title: 'Language servers', checks: languageServerChecks(f) }]
      : []),
    {
      title: 'MCP',
      checks: f.mcp.map((m) => ({
        label: m.id,
        status: m.state === 'connected' ? 'ok' : m.state === 'error' ? 'fail' : 'warn',
        detail:
          m.state === 'connected'
            ? (m.detail ?? 'connected')
            : m.state === 'needs-auth'
              ? 'needs sign-in'
              : m.state === 'idle'
                ? 'not connected yet'
                : (m.detail ?? 'failed to connect'),
        ...(m.state === 'needs-auth' ? { fix: '/mcp login <n>' } : {})
      }))
    }
  ]

  // The Terminal group only applies to the interactive terminal client.
  if (f.terminal) {
    const t = f.terminal
    groups.push({
      title: 'Terminal',
      checks: [
        {
          label: 'tty',
          status: t.tty ? 'ok' : 'warn',
          detail: t.tty ? `${t.columns} columns` : 'not a terminal',
          ...(t.tty ? {} : { fix: 'interactive mode needs a terminal; use -p for pipes' })
        },
        {
          label: 'color',
          status: 'ok',
          detail: `${t.color ? 'on' : 'off'} (TERM=${t.term || 'unset'})`
        }
      ]
    })
  }

  return { groups }
}
