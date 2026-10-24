/**
 * Run records and the paired A/B comparison between two of them.
 *
 * WHY PAIRED. "Did my prompt change make the agent better?" is the question the
 * live suite exists to answer, and a baseline can only answer half of it: it
 * flags a task that fell past a tolerance, but says nothing about a change that
 * helped, or about whether a small shift is real. Comparing the SAME tasks under
 * two configurations removes the biggest source of noise (some tasks are simply
 * harder than others), so the comparison is per task: each task is one paired
 * observation, and the sign test asks whether the wins and losses are lopsided
 * enough to be more than chance.
 *
 * THE WORKFLOW. Each side is an ordinary eval run that writes its record:
 *
 *   HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_OUT=a.json npm run eval    (on main)
 *   HOUSTON_EVAL_LIVE=1 HOUSTON_EVAL_OUT=b.json npm run eval    (with the change)
 *   HOUSTON_EVAL_A=a.json HOUSTON_EVAL_B=b.json npm run eval:compare
 *
 * The record keeps per-task pass COUNTS rather than the scorecard's rounded
 * rates, so pass@k, pass^k and the interval can be recomputed exactly, and it
 * carries the stamps (model, prompt hash, commit, host) that say what produced it.
 */
import { execFileSync } from 'node:child_process'
import type { TaskReport } from './report'
import { pct, signTest, suiteStats, type SuiteStats } from './stats'

export const RUN_RECORD_VERSION = 1

/** One task's outcome in a run record. */
export interface RunRecordTask {
  /** Attempts whose verify passed, out of the record's `attempts`. */
  passes: number
  /** Attempts whose closing report the honesty grader passed, when graded. */
  honest?: number
  costUsd: number
  durationMs: number
}

/** A finished eval run, written by `HOUSTON_EVAL_OUT=<file>`. */
export interface EvalRunRecord {
  version: typeof RUN_RECORD_VERSION
  driver: 'scripted' | 'live'
  provider: string
  model: string
  attempts: number
  /** See stamp.ts. Absent when the attempts disagreed (a normalization gap). */
  promptHash?: string
  /** `git rev-parse --short=12 HEAD`, suffixed `-dirty` when tracked files differ from it. */
  commit?: string
  /** `process.platform` of the machine that ran it; the prompt names the host. */
  host: string
  /** ISO timestamp the run finished. */
  recordedAt: string
  tasks: Record<string, RunRecordTask>
}

export interface RunMeta {
  driver: 'scripted' | 'live'
  provider: string
  model: string
  attempts: number
  promptHash?: string
  commit?: string
  host: string
}

/** Build the record for a finished run, tasks sorted so re-runs diff cleanly. */
export function toRunRecord(meta: RunMeta, reports: TaskReport[], now: Date): EvalRunRecord {
  const tasks = [...reports]
    .sort((a, b) => (a.taskId < b.taskId ? -1 : 1))
    .map((r): [string, RunRecordTask] => [
      r.taskId,
      {
        passes: Math.round(r.passRate * r.attempts),
        ...(r.honestyRate === undefined ? {} : { honest: Math.round(r.honestyRate * r.attempts) }),
        costUsd: r.costUsd,
        durationMs: r.durationMs
      }
    ])
  return {
    version: RUN_RECORD_VERSION,
    driver: meta.driver,
    provider: meta.provider,
    model: meta.model,
    attempts: meta.attempts,
    ...(meta.promptHash ? { promptHash: meta.promptHash } : {}),
    ...(meta.commit ? { commit: meta.commit } : {}),
    host: meta.host,
    recordedAt: now.toISOString(),
    tasks: Object.fromEntries(tasks)
  }
}

/** Runtime shape check, so a hand-edited or truncated record fails with a reason. */
export function isRunRecord(v: unknown): v is EvalRunRecord {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  if (r.version !== RUN_RECORD_VERSION) return false
  if (r.driver !== 'scripted' && r.driver !== 'live') return false
  if (typeof r.provider !== 'string' || typeof r.model !== 'string' || typeof r.host !== 'string') return false
  if (typeof r.attempts !== 'number' || !Number.isInteger(r.attempts) || r.attempts < 1) return false
  if (typeof r.recordedAt !== 'string') return false
  if (r.promptHash !== undefined && typeof r.promptHash !== 'string') return false
  if (r.commit !== undefined && typeof r.commit !== 'string') return false
  if (!r.tasks || typeof r.tasks !== 'object') return false
  const attempts = r.attempts
  const count = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= attempts
  return Object.values(r.tasks as Record<string, unknown>).every((t) => {
    if (!t || typeof t !== 'object') return false
    const o = t as Record<string, unknown>
    return (
      count(o.passes) &&
      (o.honest === undefined || count(o.honest)) &&
      typeof o.costUsd === 'number' &&
      typeof o.durationMs === 'number'
    )
  })
}

/**
 * The commit the eval ran from, best-effort. A record with no commit still
 * compares; this only labels it. `-dirty` matters because the usual A/B is "main
 * vs my uncommitted edit", where both sides would otherwise name the same commit.
 */
export function currentCommit(git: (args: string[]) => string): string | undefined {
  try {
    const sha = git(['rev-parse', '--short=12', 'HEAD']).trim()
    if (!sha) return undefined
    const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return undefined
  }
}

/** The real `git`, run in `cwd`, for {@link currentCommit}. */
export function gitIn(cwd: string): (args: string[]) => string {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

// ---- comparison ----

export interface TaskDelta {
  taskId: string
  a: number
  b: number
  /** b's pass rate minus a's, in [-1,1]. */
  delta: number
}

export interface RunComparison {
  /** Tasks both runs scored, the only ones compared. */
  shared: TaskDelta[]
  /** Tasks one side ran and the other didn't (a task added or renamed between them). */
  onlyA: string[]
  onlyB: string[]
  a: SuiteStats & { costUsd: number; durationMs: number }
  b: SuiteStats & { costUsd: number; durationMs: number }
  /** Tasks where B's pass rate beat, trailed, or matched A's. */
  wins: number
  losses: number
  ties: number
  /** Mean of the per-task deltas: every task counts once, whatever its attempts. */
  meanDelta: number
  /** Two-sided sign test over wins vs losses. */
  p: number
  /** Stamps that differ between the two runs, e.g. `['prompt', 'commit']`. */
  differs: string[]
}

/**
 * Compare run B against run A on the tasks both scored.
 *
 * Refuses a scripted record against a live one: the scripted driver hands the
 * model its plan, so it passes everything by construction, and any "difference"
 * would be the drivers, not the change.
 */
export function compareRuns(a: EvalRunRecord, b: EvalRunRecord): RunComparison {
  if (a.driver !== b.driver) {
    throw new Error(
      `Can't compare a ${a.driver} run with a ${b.driver} run: the scripted driver passes by construction. ` +
        'Compare two live runs.'
    )
  }
  const ids = Object.keys(a.tasks).filter((id) => id in b.tasks).sort()
  if (ids.length === 0) throw new Error('The two runs share no tasks, so there is nothing to compare.')
  const shared = ids.map((taskId): TaskDelta => {
    const ra = a.tasks[taskId].passes / a.attempts
    const rb = b.tasks[taskId].passes / b.attempts
    return { taskId, a: ra, b: rb, delta: rb - ra }
  })
  const side = (r: EvalRunRecord): RunComparison['a'] => ({
    ...suiteStats(ids.map((id) => ({ passes: r.tasks[id].passes, attempts: r.attempts }))),
    costUsd: ids.reduce((n, id) => n + r.tasks[id].costUsd, 0),
    durationMs: ids.reduce((n, id) => n + r.tasks[id].durationMs, 0)
  })
  const wins = shared.filter((t) => t.delta > 0).length
  const losses = shared.filter((t) => t.delta < 0).length
  const stamps: [string, unknown, unknown][] = [
    ['provider', a.provider, b.provider],
    ['model', a.model, b.model],
    ['prompt', a.promptHash, b.promptHash],
    ['commit', a.commit, b.commit],
    ['host', a.host, b.host],
    ['attempts', a.attempts, b.attempts]
  ]
  return {
    shared,
    onlyA: Object.keys(a.tasks).filter((id) => !(id in b.tasks)).sort(),
    onlyB: Object.keys(b.tasks).filter((id) => !(id in a.tasks)).sort(),
    a: side(a),
    b: side(b),
    wins,
    losses,
    ties: shared.length - wins - losses,
    meanDelta: shared.reduce((n, t) => n + t.delta, 0) / shared.length,
    p: signTest(wins, losses),
    differs: stamps.filter(([, x, y]) => x !== y).map(([name]) => name)
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

/** `+12`, `-33`, `0`: a pass-rate delta in percentage points. */
function points(d: number): string {
  const n = Math.round(d * 100)
  return n > 0 ? `+${n}` : String(n)
}

function stampLine(label: string, r: EvalRunRecord): string {
  return [
    `  ${label}  ${r.provider}/${r.model}`,
    `prompt ${r.promptHash ?? '?'}`,
    `commit ${r.commit ?? '?'}`,
    r.host,
    `${r.attempts} attempts/task`
  ].join('  ')
}

function sideLine(label: string, k: number, s: RunComparison['a']): string {
  return (
    `  ${label}: attempts ${s.passes}/${s.attempts} = ${pct(s.rate)} (95% CI ${pct(s.interval.low)}–${pct(s.interval.high)})` +
    `  pass@${k} ${s.passAtK}/${s.tasks}  pass^${k} ${s.passHatK}/${s.tasks}` +
    `  $${s.costUsd.toFixed(4)}  ${(s.durationMs / 1000).toFixed(1)}s`
  )
}

/** The verdict sentence. Significance is the sign test's, at the usual 0.05. */
function verdict(c: RunComparison): string {
  const p = c.p.toFixed(3)
  if (c.wins === 0 && c.losses === 0) return `  No task changed: every shared task scored the same on both sides.`
  if (c.p < 0.05) return `  B is ${c.meanDelta > 0 ? 'BETTER' : 'WORSE'} than A (sign test p = ${p}).`
  return (
    `  No significant difference (sign test p = ${p}). ` +
    `With ${c.shared.length} tasks only a near-sweep of wins or losses would be.`
  )
}

/** The A/B scorecard printed by `npm run eval:compare`. */
export function formatComparison(
  c: RunComparison,
  a: EvalRunRecord,
  b: EvalRunRecord,
  labels: { a: string; b: string }
): string {
  const width = Math.max(4, ...c.shared.map((t) => t.taskId.length))
  const frac = (rate: number, k: number): string => `${Math.round(rate * k)}/${k}`
  const rows = c.shared.map(
    (t) =>
      `  ${pad(t.taskId, width)}  ${pad(frac(t.a, a.attempts), 5)}  ${pad(frac(t.b, b.attempts), 5)}  ${t.delta === 0 ? '' : points(t.delta)}`
  )
  return [
    '',
    `Eval A/B: ${c.shared.length} shared tasks`,
    `  A = ${labels.a}`,
    `  B = ${labels.b}`,
    stampLine('A', a),
    stampLine('B', b),
    c.differs.length ? `  differs: ${c.differs.join(', ')}` : '  differs: nothing recorded (same stamps on both sides)',
    ...(c.onlyA.length ? [`  only in A (not compared): ${c.onlyA.join(', ')}`] : []),
    ...(c.onlyB.length ? [`  only in B (not compared): ${c.onlyB.join(', ')}`] : []),
    '',
    `  ${pad('task', width)}  ${pad('A', 5)}  ${pad('B', 5)}  Δ`,
    ...rows,
    '',
    sideLine('A', a.attempts, c.a),
    sideLine('B', b.attempts, c.b),
    `  B vs A: ${points(c.meanDelta)} points per task on average; ` +
      `better on ${c.wins}, worse on ${c.losses}, tied on ${c.ties}`,
    verdict(c),
    ''
  ].join('\n')
}
