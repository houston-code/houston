/**
 * Scorecard rendering for an eval run.
 *
 * The scripted driver already fails the build per task, so the interesting output
 * is the live one: which tasks a model solved, at what rate, how that compares to
 * its recorded baseline, and what it cost. Printed to the job log rather than
 * uploaded anywhere — the same local-only posture as the conversation scorecard
 * in @shared/scorecard.
 */
import type { BaselineVerdict } from './baseline'
import type { EvalResult } from './types'

export interface ReportHeader {
  driver: 'scripted' | 'live'
  /** Provider/model the run drove, for the live scorecard's title line. */
  model: string
  /** Attempts per task. >1 in live mode, to average out model noise. */
  attempts: number
}

/** One task's aggregate across its attempts. */
export interface TaskReport {
  taskId: string
  attempts: number
  /** Passes / attempts, in [0,1]. */
  passRate: number
  /** A representative attempt — the first failure if there was one, else the last. */
  sample: EvalResult
  /** Summed across every attempt, not just the sample. */
  costUsd: number
  durationMs: number
  /** Present in live mode once the run has been graded against a baseline. */
  verdict?: BaselineVerdict
}

export function summarize(reports: TaskReport[]): {
  solved: number
  total: number
  costUsd: number
  durationMs: number
} {
  return {
    // "Solved" is a majority of attempts, so one flake doesn't erase a task.
    solved: reports.filter((r) => r.passRate > 0.5).length,
    total: reports.length,
    costUsd: reports.reduce((n, r) => n + r.costUsd, 0),
    durationMs: reports.reduce((n, r) => n + r.durationMs, 0)
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** `REGRESSED -0.67` and friends — the column that makes a nightly worth reading. */
function fmtVerdict(v: BaselineVerdict | undefined): string {
  if (!v) return ''
  switch (v.kind) {
    case 'regressed':
      return `  REGRESSED (baseline ${v.baseline.toFixed(2)}, now ${v.observed.toFixed(2)})`
    case 'improved':
      return `  improved (baseline ${v.baseline.toFixed(2)}, now ${v.observed.toFixed(2)} — re-record)`
    case 'unrecorded':
      return '  unrecorded (not in the baseline yet)'
    case 'held':
      return ''
  }
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0)
  return line ? line.trim().slice(0, 120) : '(verify produced no output)'
}

/** A fixed-width scorecard: one row per task, then a totals line. */
export function formatReport(header: ReportHeader, reports: TaskReport[]): string {
  const { solved, total, costUsd, durationMs } = summarize(reports)
  const width = Math.max(4, ...reports.map((r) => r.taskId.length))
  const rows = reports.map((r) => {
    const mark = r.passRate > 0.5 ? 'PASS' : 'FAIL'
    // Only show the rate when it can be something other than 0 or 1.
    const rate = header.attempts > 1 ? `  ${Math.round(r.passRate * r.attempts)}/${r.attempts}` : ''
    const secs = `${(r.durationMs / 1000).toFixed(1)}s`
    const tools = r.sample.toolsUsed.length ? r.sample.toolsUsed.join(' > ') : '(no tools)'
    const why =
      r.passRate === 1 ? '' : `\n      ${r.sample.error ?? firstLine(r.sample.verifyOutput)}`
    return `  ${mark}${rate}  ${pad(r.taskId, width)}  ${pad(secs, 6)}  ${tools}${fmtVerdict(r.verdict)}${why}`
  })
  const pct = total ? Math.round((solved / total) * 100) : 0
  return [
    '',
    `Task evals — ${header.driver} driver — ${header.model}${header.attempts > 1 ? ` — ${header.attempts} attempts/task` : ''}`,
    ...rows,
    '',
    `  ${solved}/${total} solved (${pct}%)  ${(durationMs / 1000).toFixed(1)}s  $${costUsd.toFixed(4)}`,
    ''
  ].join('\n')
}
