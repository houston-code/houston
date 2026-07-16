/**
 * Scorecard rendering for an eval run.
 *
 * The scripted driver already fails the build per task, so this exists mainly for
 * the live driver, where the interesting output is the aggregate: which tasks a
 * given model solved, how much it cost, and what it reached for. Printed to the
 * job log rather than uploaded anywhere — the same local-only posture as the
 * conversation scorecard in @shared/scorecard.
 */
import type { EvalResult } from './types'

export interface ReportHeader {
  driver: 'scripted' | 'live'
  /** Provider/model the run drove, for the live scorecard's title line. */
  model: string
}

/** `3/8 passed` and the money, for the summary line. */
export function summarize(results: EvalResult[]): {
  passed: number
  total: number
  costUsd: number
  durationMs: number
} {
  return {
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    costUsd: results.reduce((n, r) => n + r.costUsd, 0),
    durationMs: results.reduce((n, r) => n + r.durationMs, 0)
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** A fixed-width scorecard: one row per task, then a totals line. */
export function formatReport(header: ReportHeader, results: EvalResult[]): string {
  const { passed, total, costUsd, durationMs } = summarize(results)
  const width = Math.max(4, ...results.map((r) => r.taskId.length))
  const rows = results.map((r) => {
    const mark = r.passed ? 'PASS' : 'FAIL'
    const secs = `${(r.durationMs / 1000).toFixed(1)}s`
    const tools = r.toolsUsed.length ? r.toolsUsed.join(' > ') : '(no tools)'
    const why = r.passed ? '' : `\n      ${r.error ?? firstLine(r.verifyOutput)}`
    return `  ${mark}  ${pad(r.taskId, width)}  ${pad(secs, 6)}  ${tools}${why}`
  })
  const pct = total ? Math.round((passed / total) * 100) : 0
  return [
    '',
    `Task evals — ${header.driver} driver — ${header.model}`,
    ...rows,
    '',
    `  ${passed}/${total} passed (${pct}%)  ${(durationMs / 1000).toFixed(1)}s  $${costUsd.toFixed(4)}`,
    ''
  ].join('\n')
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0)
  return line ? line.trim().slice(0, 120) : '(verify produced no output)'
}
