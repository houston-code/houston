import { buildDoctorReport, type DoctorFacts } from './doctor'
import { defaultSettings } from './defaults'

/**
 * The text Help > Report an Issue puts in a new GitHub issue: blank prompts for the
 * user to fill in, then the app version, the platform, and a summary of the `/doctor`
 * checks.
 *
 * It goes into a URL the browser opens and then into a public issue, so it carries
 * only what is safe to publish: each check's name and status, never its detail
 * (details hold file paths, folder names and error text). Names the user chose (MCP
 * servers, custom providers) are counted rather than named, and the settings and
 * workspace rows (paths) are left out. No logs, paths or keys are ever included, and
 * the user sees this exact text before anything opens.
 */

/** Doctor rows whose detail is a path; their status is always ok, so they add nothing. */
const OMITTED_LABELS = new Set(['settings', 'workspace'])

/** Provider ids Houston ships with; any other provider id is the user's own name. */
const BUILT_IN_PROVIDERS = new Set(defaultSettings().providers.map((p) => p.id))

/** Groups summarized by status counts only. */
const COUNTED_GROUPS = new Set(['MCP', 'Language servers'])

/** Labels in the Model group that are not provider ids. */
const MODEL_GROUP_LABELS = new Set(['active', 'active model', 'providers'])

/** "2 ok, 1 warn" for a list of statuses, or "none". */
function counts(statuses: readonly string[]): string {
  const n = new Map<string, number>()
  for (const s of statuses) n.set(s, (n.get(s) ?? 0) + 1)
  return [...n].map(([status, k]) => `${k} ${status}`).join(', ') || 'none'
}

export function issueReportBody(facts: DoctorFacts): string {
  const report = buildDoctorReport(facts)
  const lines: string[] = []
  for (const group of report.groups) {
    // Server names here can be the user's own (an MCP server, a language server they
    // added), so these groups say only how many checks are in each state.
    if (COUNTED_GROUPS.has(group.title)) {
      lines.push(`- ${group.title}: ${counts(group.checks.map((c) => c.status))}`)
      continue
    }
    const named: string[] = []
    const custom: string[] = []
    for (const c of group.checks) {
      if (OMITTED_LABELS.has(c.label)) continue
      if (group.title === 'Model' && !MODEL_GROUP_LABELS.has(c.label) && !BUILT_IN_PROVIDERS.has(c.label)) {
        custom.push(c.status)
      } else named.push(`${c.label} ${c.status}`)
    }
    if (custom.length) named.push(`other providers: ${counts(custom)}`)
    if (named.length) lines.push(`- ${group.title}: ${named.join(', ')}`)
  }
  return [
    '### What happened?',
    '',
    '',
    '### What did you expect to happen?',
    '',
    '',
    '### Steps to reproduce',
    '',
    '',
    '### Environment',
    '',
    `- Houston ${facts.version}`,
    `- Platform: ${facts.platform}`,
    `- Node: ${facts.nodeVersion}`,
    '',
    '### Diagnostics',
    '',
    ...lines,
    ''
  ].join('\n')
}

/** The new-issue page with `body` filled in. */
export function issueReportUrl(base: string, body: string): string {
  return `${base}?body=${encodeURIComponent(body)}`
}
