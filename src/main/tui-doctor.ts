import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'
import type { DoctorCheck, DoctorReport } from '@shared/doctor'

/**
 * `/doctor` in the terminal: paint the graded report. The grading (and the
 * `DoctorFacts`/`buildDoctorReport` shared with the desktop app) lives in
 * `@shared/doctor`; this module is only the terminal's renderer.
 */

// Re-exported so the terminal host (terminalEntry.ts) can keep importing the facts
// type from here, and so `buildDoctorReport` is reachable next to its renderer.
export {
  buildDoctorReport,
  type DoctorCheck,
  type DoctorReport,
  type DoctorFacts
} from '@shared/doctor'

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
