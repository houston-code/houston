import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * `/doctor`: the "why isn't this working" report.
 *
 * Everything here was already knowable — the sandbox backend, whether a key is
 * really being used or shadowed by an env var, which MCP server failed to connect
 * — but only by reading source or guessing. When a terminal user hits a wall, the
 * first question is which layer broke, and nothing answered it.
 *
 * Pure: the host gathers the facts (probing binaries, reading settings) and this
 * renders them, so the report is unit-testable without a machine to probe.
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

const MARK: Record<DoctorCheck['status'], string> = { ok: '✓', warn: '!', fail: '✗' }
const TONE: Record<DoctorCheck['status'], 'green' | 'yellow' | 'red'> = {
  ok: 'green',
  warn: 'yellow',
  fail: 'red'
}

/** Render the report: grouped rows, then a one-line verdict. */
export function renderDoctor(report: DoctorReport, paint: Painter): string {
  const lines: string[] = []
  const width = Math.max(
    0,
    ...report.groups.flatMap((g) => g.checks.map((c) => c.label.length))
  )
  for (const group of report.groups) {
    if (!group.checks.length) continue
    lines.push(paint(group.title, 'bold'))
    for (const c of group.checks) {
      // `detail` can carry remote text (an MCP server's error message), so it is
      // stripped of control characters before it reaches the terminal.
      lines.push(
        `  ${paint(MARK[c.status], TONE[c.status])} ${c.label.padEnd(width)}  ${stripControlChars(c.detail)}`
      )
      // Only tell people what to do when something is actually wrong.
      if (c.fix && c.status !== 'ok') lines.push(`    ${paint(`→ ${stripControlChars(c.fix)}`, 'dim')}`)
    }
    lines.push('')
  }
  const all = report.groups.flatMap((g) => g.checks)
  const fails = all.filter((c) => c.status === 'fail').length
  const warns = all.filter((c) => c.status === 'warn').length
  lines.push(
    fails
      ? paint(`${fails} problem${fails === 1 ? '' : 's'} found${warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : ''}.`, 'red')
      : warns
        ? paint(`No problems; ${warns} thing${warns === 1 ? '' : 's'} worth knowing.`, 'yellow')
        : paint('Everything looks healthy.', 'green')
  )
  return lines.join('\n')
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
  terminal: { tty: boolean; color: boolean; columns: number; term: string }
  /** Newer release, when the update check found one. */
  update: { latest: string; url: string } | null
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

  return {
    groups: [
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
      },
      {
        title: 'Terminal',
        checks: [
          {
            label: 'tty',
            status: f.terminal.tty ? 'ok' : 'warn',
            detail: f.terminal.tty ? `${f.terminal.columns} columns` : 'not a terminal',
            ...(f.terminal.tty ? {} : { fix: 'interactive mode needs a terminal; use -p for pipes' })
          },
          {
            label: 'color',
            status: 'ok',
            detail: `${f.terminal.color ? 'on' : 'off'} (TERM=${f.terminal.term || 'unset'})`
          }
        ]
      }
    ]
  }
}
