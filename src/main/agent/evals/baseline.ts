/**
 * Per-model quality baselines for the live eval driver.
 *
 * WHY THIS EXISTS. Neither of the other two guards can catch a *quality*
 * regression:
 *
 *  - The goldens catch a *shape* change (the prompt text moved, a tool schema
 *    changed). They cannot tell you the change made the agent WORSE — that
 *    judgement is a human reading the diff, and `npm run goldens:update` accepts
 *    it in one command.
 *  - The scripted eval driver hands the agent a correct plan, so it grades
 *    execution, not judgement. Gut the entire system prompt and the scripted
 *    suite still passes every task, because the answer was in the script.
 *
 * Only a real model solving a real task measures quality, and a live score is
 * worth nothing without something to compare it against: a scorecard printed to
 * a job log is not a regression test, it's a log line. A baseline turns the live
 * run into a benchmark — record what a model scores today, and fail the nightly
 * when it scores materially worse tomorrow.
 *
 * Baselines are checked in and reviewed like goldens: `npm run eval:baseline`
 * records one, and the diff documents the behavior change in the PR.
 */

/** A recorded per-model score, checked in under `evals/baselines/`. */
export interface EvalBaseline {
  provider: string
  model: string
  /** Attempts per task the baseline was recorded over — the pass rate's denominator. */
  attempts: number
  /** ISO date the baseline was recorded, so a stale one is obvious in review. */
  recordedAt: string
  /** taskId -> observed pass rate in [0,1]. */
  tasks: Record<string, number>
}

/** What one task scored in the run being graded. */
export interface TaskScore {
  taskId: string
  /** Passes / attempts, in [0,1]. */
  passRate: number
  attempts: number
}

/**
 * How far a task may fall below its baseline before it counts as a regression.
 *
 * A live model is genuinely noisy: the same task can pass 3/3 one night and 2/3
 * the next without anything changing. At the default 3 attempts one flaked
 * attempt is a 0.33 drop, so this absorbs exactly one flake and fails on two.
 * Tightening it below 1/attempts makes every flake a red nightly, which trains
 * everyone to ignore the job — the failure mode this whole file exists to avoid.
 */
export const DEFAULT_TOLERANCE = 0.34

export type BaselineVerdict =
  /** Scored materially below the baseline — the signal this benchmark exists for. */
  | { kind: 'regressed'; taskId: string; baseline: number; observed: number }
  /** Scored above the baseline: not a failure, but the baseline is now stale. */
  | { kind: 'improved'; taskId: string; baseline: number; observed: number }
  /** Held its baseline (within tolerance). */
  | { kind: 'held'; taskId: string; baseline: number; observed: number }
  /** Ran, but the baseline predates it — record a new baseline to start gating it. */
  | { kind: 'unrecorded'; taskId: string; observed: number }

/**
 * Grade a run against a baseline, one verdict per task scored.
 *
 * Tasks present in the baseline but absent from `scores` are ignored rather than
 * failed: that is a task being deleted or renamed, which the suite's own
 * registration check already covers, and failing here would just duplicate it.
 */
export function compareToBaseline(
  baseline: EvalBaseline,
  scores: TaskScore[],
  tolerance = DEFAULT_TOLERANCE
): BaselineVerdict[] {
  return scores.map((s) => {
    const base = baseline.tasks[s.taskId]
    if (base === undefined) return { kind: 'unrecorded', taskId: s.taskId, observed: s.passRate }
    if (s.passRate < base - tolerance) {
      return { kind: 'regressed', taskId: s.taskId, baseline: base, observed: s.passRate }
    }
    if (s.passRate > base) return { kind: 'improved', taskId: s.taskId, baseline: base, observed: s.passRate }
    return { kind: 'held', taskId: s.taskId, baseline: base, observed: s.passRate }
  })
}

/** The regressions in a verdict list — non-empty means the benchmark failed. */
export function regressions(verdicts: BaselineVerdict[]): Extract<BaselineVerdict, { kind: 'regressed' }>[] {
  return verdicts.filter((v) => v.kind === 'regressed')
}

/** Build a baseline from a run's scores, ready to serialize and commit. */
export function recordBaseline(
  provider: string,
  model: string,
  attempts: number,
  scores: TaskScore[],
  now: Date
): EvalBaseline {
  return {
    provider,
    model,
    attempts,
    recordedAt: now.toISOString().slice(0, 10),
    // Sorted so re-recording an unchanged score produces no diff noise.
    tasks: Object.fromEntries(
      [...scores].sort((a, b) => (a.taskId < b.taskId ? -1 : 1)).map((s) => [s.taskId, s.passRate])
    )
  }
}

/** File name for a provider/model pair. Model ids can carry `/` on aggregator routes. */
export function baselineFileName(provider: string, model: string): string {
  return `${provider}.${model.replace(/\//g, '_')}.json`
}

/** Runtime shape check — a hand-edited baseline shouldn't fail as a mystery. */
export function isEvalBaseline(v: unknown): v is EvalBaseline {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  if (typeof b.provider !== 'string' || typeof b.model !== 'string') return false
  if (typeof b.attempts !== 'number' || typeof b.recordedAt !== 'string') return false
  if (!b.tasks || typeof b.tasks !== 'object') return false
  return Object.values(b.tasks as Record<string, unknown>).every(
    (n) => typeof n === 'number' && n >= 0 && n <= 1
  )
}
