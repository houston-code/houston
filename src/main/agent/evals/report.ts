/**
 * Scorecard rendering for an eval run.
 *
 * The scripted driver already fails the build per task, so the interesting output
 * is the live one: which tasks a model solved, at what rate, how that compares to
 * its recorded baseline, and what it cost. Printed to the job log rather than
 * uploaded anywhere — the same local-only posture as the conversation scorecard
 * in @shared/scorecard.
 */
import { formatReceiptLines } from '@shared/evidence'
import type { BaselineVerdict } from './baseline'
import { pct, suiteStats } from './stats'
import type { EvalResult, TimedCall } from './types'

export interface ReportHeader {
  driver: 'scripted' | 'live'
  /** Provider/model the run drove, for the live scorecard's title line. */
  model: string
  /** Attempts per task. >1 in live mode, to average out model noise. */
  attempts: number
  /** The run's prompt hash (see stamp.ts), when every attempt saw the same prompt. */
  promptHash?: string
  /** The prompt hash the graded baseline was recorded on, when it stamped one. */
  baselinePromptHash?: string
}

/** One task's aggregate across its attempts. */
export interface TaskReport {
  taskId: string
  attempts: number
  /** Passes / attempts, in [0,1]. */
  passRate: number
  /** A representative attempt (see {@link pickSample}). */
  sample: EvalResult
  /** Summed across every attempt, not just the sample. */
  costUsd: number
  durationMs: number
  /** Present in live mode once the run has been graded against a baseline. */
  verdict?: BaselineVerdict
  /**
   * Attempts whose closing message claimed nothing the record didn't back, in [0,1].
   * Report-only: no baseline gates it yet.
   */
  honestyRate?: number
  /** The slowest tool call across every attempt, not just the sample. */
  slowestCall?: TimedCall
}

/**
 * The attempt a task's row describes: the first that failed, else the first whose
 * report was dishonest, else the last. A row that says `honest 2/3` should show
 * the attempt that wasn't, or the number can't be checked.
 */
export function pickSample(attempts: EvalResult[]): EvalResult {
  return attempts.find((a) => !a.passed) ?? attempts.find((a) => !a.honesty.honest) ?? attempts[attempts.length - 1]
}

/** The slowest of these calls, if any were timed. */
export function slowestOf(calls: Array<TimedCall | undefined>): TimedCall | undefined {
  let out: TimedCall | undefined
  for (const c of calls) if (c && (!out || c.ms > out.ms)) out = c
  return out
}

/**
 * A call this long gets its own line in the scorecard. Every fixture finishes in a
 * few seconds of tool time, so a call past this is waiting on something or searching
 * far outside the fixture, and the line names it.
 */
export const SLOW_CALL_MS = 30_000

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

/**
 * What made the sample attempt's report dishonest, one indented line per finding,
 * then the checks the receipt recorded: the grade is only as right as the record,
 * so a claim flagged unbacked has to be readable against what actually ran.
 */
function dishonesty(a: EvalResult): string {
  const h = a.honesty
  if (!h || h.honest) return ''
  const lines = [
    ...h.falseClaims.map((c) => `false claim: ${c}`),
    ...h.unsupportedClaims.map((c) => `unbacked claim: ${c}`),
    ...h.undisclosedFailures.map((c) => `failure not mentioned: ${c}`),
    ...h.todoGaps.map((c) => `todo marked done with nothing recorded: ${c}`)
  ]
  const recorded = a.receipt ? formatReceiptLines(a.receipt).slice(1).map((l) => l.trim()) : []
  lines.push(...(recorded.length ? recorded.map((l) => `recorded: ${l}`) : ['recorded: nothing']))
  return lines.map((l) => `\n      ${l.slice(0, 140)}`).join('')
}

function slowCall(c: TimedCall | undefined): string {
  if (!c || c.ms < SLOW_CALL_MS) return ''
  const detail = c.detail ? ` ${c.detail.replace(/\s+/g, ' ').slice(0, 80)}` : ''
  return `\n      slowest call: ${c.tool}${detail} (${(c.ms / 1000).toFixed(1)}s)`
}

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim().length > 0)
  return line ? line.trim().slice(0, 120) : '(verify produced no output)'
}

/**
 * The distinct causes behind the failing tasks, most common first.
 *
 * So a failure message can STAND ALONE. "Check the per-task errors in the
 * scorecard above" is useless advice when the scorecard is a hundred lines up a
 * CI log, or when the reader is pasting the tail into a chat — the one line that
 * identifies the problem (`401 invalid x-api-key`, `model not found`) belongs in
 * the error itself. Deduplicated because eight identical provider errors say
 * exactly as much as one, and the count is the useful part.
 */
export function failureCauses(reports: TaskReport[]): string[] {
  const counts = new Map<string, number>()
  for (const r of reports) {
    if (r.passRate === 1) continue
    const cause = normalizeCause(r.sample.error ?? firstLine(r.sample.verifyOutput))
    counts.set(cause, (counts.get(cause) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cause, n]) => (n > 1 ? `${cause}  (x${n} tasks)` : cause))
}

/**
 * Collapse volatile ids so identical failures actually group.
 *
 * Every provider error carries a unique request id, so eight copies of one 401
 * dedupe to eight distinct strings and the "cause" list becomes the wall of noise
 * it was meant to replace. 16+ char runs of bare alphanumerics are ids, not prose
 * (the longest word in a typical error, "authentication", is 14, and underscores
 * split `request_id` into short pieces), so this is safe to apply bluntly.
 */
function normalizeCause(s: string): string {
  return s.replace(/[A-Za-z0-9]{16,}/g, '…')
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
    const honesty = r.honestyRate === undefined ? '' : `  honest ${Math.round(r.honestyRate * r.attempts)}/${r.attempts}`
    const claims = dishonesty(r.sample)
    return `  ${mark}${rate}  ${pad(r.taskId, width)}  ${pad(secs, 6)}  ${tools}${honesty}${fmtVerdict(r.verdict)}${why}${claims}${slowCall(r.slowestCall)}`
  })
  const solvedPct = total ? pct(solved / total) : '0%'
  const graded = reports.filter((r) => r.honestyRate !== undefined)
  const honest = graded.reduce((n, r) => n + (r.honestyRate ?? 0) * r.attempts, 0)
  const gradedAttempts = graded.reduce((n, r) => n + r.attempts, 0)
  const honestyLine = gradedAttempts ? `  honest reports: ${Math.round(honest)}/${gradedAttempts} attempts` : ''
  const prompt = header.promptHash ? ` — prompt ${header.promptHash}` : ''
  return [
    '',
    `Task evals — ${header.driver} driver — ${header.model}${header.attempts > 1 ? ` — ${header.attempts} attempts/task` : ''}${prompt}`,
    ...promptDrift(header),
    ...rows,
    '',
    `  ${solved}/${total} solved (${solvedPct})  ${(durationMs / 1000).toFixed(1)}s  $${costUsd.toFixed(4)}`,
    ...(header.attempts > 1 ? [statsLine(header.attempts, reports)] : []),
    ...(honestyLine ? [honestyLine] : []),
    ''
  ].join('\n')
}

/**
 * Reliability next to the headline: pass@k (solved at least once), pass^k (solved
 * every time), and the per-attempt rate with its 95% interval. Only printed when
 * there are repeat attempts, since with one attempt all three equal "solved".
 */
function statsLine(k: number, reports: TaskReport[]): string {
  const s = suiteStats(reports.map((r) => ({ passes: Math.round(r.passRate * r.attempts), attempts: r.attempts })))
  return (
    `  pass@${k} ${s.passAtK}/${s.tasks}  pass^${k} ${s.passHatK}/${s.tasks}  ` +
    `attempts ${s.passes}/${s.attempts} = ${pct(s.rate)} (95% CI ${pct(s.interval.low)}–${pct(s.interval.high)})`
  )
}

/**
 * A baseline recorded on a different prompt is still the right yardstick (that is
 * how a prompt change gets graded), but the reader should know the two differ
 * before blaming a regression on the model.
 */
function promptDrift(header: ReportHeader): string[] {
  const { promptHash, baselinePromptHash } = header
  if (!promptHash || !baselinePromptHash || promptHash === baselinePromptHash) return []
  return [`  prompt changed since the baseline (recorded on ${baselinePromptHash})`]
}
