import { buildDoctorReport, type DoctorFacts, type DoctorReport } from '@shared/doctor'
import { stripControlChars } from '../main/tui-wrap'

/**
 * `houston doctor [--json]`: the `/doctor` report without starting a session, for a
 * setup script, a CI step, or a bug report. The checks and their grading are the
 * interactive `/doctor`'s (`@shared/doctor`); the host gathers the facts, connecting
 * each enabled MCP server first so its row says whether it really connects.
 *
 * Exit codes: 0 when nothing failed (warnings included), 1 when a check failed, 2 for
 * a bad argument. `--json` prints one object in the documented shape
 * (docs/schemas/doctor.schema.json) instead of the painted report.
 */

export const DOCTOR_USAGE = `Usage: houston doctor [--json]
  Checks your setup: version and updates, Node, the model and every provider's key
  (never the key itself), the shell sandbox, git/gh/rg, language servers, and each
  enabled MCP server. Exits 1 when a check fails.
  --json   print the report as one JSON object (docs/schemas/doctor.schema.json)
`

/** Bump only for a breaking change to the JSON shape; adding a field is not one. */
export const DOCTOR_JSON_SCHEMA_VERSION = 1

export interface DoctorJson {
  schemaVersion: number
  version: string
  /** False when any check failed (the exit code is then 1). */
  ok: boolean
  counts: { ok: number; warn: number; fail: number }
  groups: {
    title: string
    checks: { label: string; status: 'ok' | 'warn' | 'fail'; detail: string; fix?: string }[]
  }[]
}

/** The report as the stable JSON shape. Pure. */
export function doctorJson(report: DoctorReport, version: string): DoctorJson {
  const groups = report.groups
    .filter((g) => g.checks.length)
    .map((g) => ({
      title: g.title,
      checks: g.checks.map((c) => ({
        label: c.label,
        status: c.status,
        detail: c.detail,
        ...(c.fix && c.status !== 'ok' ? { fix: c.fix } : {})
      }))
    }))
  const all = groups.flatMap((g) => g.checks)
  const counts = {
    ok: all.filter((c) => c.status === 'ok').length,
    warn: all.filter((c) => c.status === 'warn').length,
    fail: all.filter((c) => c.status === 'fail').length
  }
  return { schemaVersion: DOCTOR_JSON_SCHEMA_VERSION, version, ok: counts.fail === 0, counts, groups }
}

/** 1 when any check failed, else 0. */
export function doctorExitCode(report: DoctorReport): number {
  return report.groups.some((g) => g.checks.some((c) => c.status === 'fail')) ? 1 : 0
}

export interface DoctorCliDeps {
  /** Probe the machine (connecting each enabled MCP server). */
  facts: () => Promise<DoctorFacts>
  /** The painted report for a person (the interactive `/doctor`'s renderer). */
  render: (report: DoctorReport) => string
  out: (s: string) => void
  err: (s: string) => void
  /** Say what is happening while the probe runs (to stderr, at a terminal); absent stays silent. */
  progress?: (message: string) => void
}

/** Route `houston doctor [--json]`. Returns the exit code. */
export async function runDoctorCommand(args: string[], deps: DoctorCliDeps): Promise<number> {
  let json = false
  for (const a of args) {
    if (a === '--json') json = true
    else if (a === '-h' || a === '--help') {
      deps.out(DOCTOR_USAGE)
      return 0
    } else {
      deps.err(`houston: doctor takes no ${a.startsWith('-') ? `option ${stripControlChars(a)}` : `argument "${stripControlChars(a)}"`}\n${DOCTOR_USAGE}`)
      return 2
    }
  }
  if (!json) deps.progress?.('Checking your setup...')
  let facts: DoctorFacts
  try {
    facts = await deps.facts()
  } catch (e) {
    deps.err(`houston: couldn't run the checks: ${(e as Error).message}\n`)
    return 1
  }
  const report = buildDoctorReport(facts, 'shell')
  deps.out(json ? `${JSON.stringify(doctorJson(report, facts.version), null, 2)}\n` : `${deps.render(report)}\n`)
  return doctorExitCode(report)
}
