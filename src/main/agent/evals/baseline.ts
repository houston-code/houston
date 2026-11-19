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
import { stratifiedDropTest } from './stats'
import { isProbeResultId } from './types'

/** A recorded per-model score, checked in under `evals/baselines/`. */
export interface EvalBaseline {
  provider: string
  model: string
  /** Attempts per task the baseline was recorded over — the pass rate's denominator. */
  attempts: number
  /** ISO date the baseline was recorded, so a stale one is obvious in review. */
  recordedAt: string
  /**
   * The prompt hash it was recorded on (see stamp.ts), so a later run can say the
   * prompt has changed since. Absent on baselines recorded before the stamp existed.
   */
  promptHash?: string
  /**
   * The reasoning effort the driver ran at (the shipped default, DEFAULT_REASONING_EFFORT).
   * It reaches the request as a parameter, not as prompt text, so the prompt hash can't
   * see it change. Absent on baselines recorded before it was stamped.
   */
  reasoningEffort?: string
  /** The commit the baseline was recorded on, as a run record names it (see currentCommit). */
  commit?: string
  /** taskId -> observed pass rate in [0,1]. */
  tasks: Record<string, number>
}

/** The stamps a baseline records beside its scores, when the run had them. */
export interface BaselineStamps {
  promptHash?: string
  reasoningEffort?: string
  commit?: string
}

/** What one task scored in the run being graded. */
export interface TaskScore {
  taskId: string
  /** Passes / attempts, in [0,1]. */
  passRate: number
  attempts: number
}

/**
 * How far a task may fall below its baseline before it is reported as `dropped`.
 *
 * A live model is genuinely noisy: the same task can pass 3/3 one night and 2/3
 * the next without anything changing. At the default 3 attempts one flaked
 * attempt is a 0.33 drop, so this absorbs exactly one flake and reports two. A
 * `dropped` task is printed in the scorecard and does NOT fail the run: see
 * {@link compareToBaseline} for why only a collapse does.
 */
export const DEFAULT_TOLERANCE = 0.34

export type BaselineVerdict =
  /**
   * Collapsed: every baseline attempt passed and no attempt passes now. The only
   * per-task verdict that fails the run; see compareToBaseline.
   */
  | { kind: 'regressed'; taskId: string; baseline: number; observed: number }
  /**
   * Fell past the tolerance without collapsing (3/3 to 1/3, 2/3 to 0/3). Reported, not
   * failed: at three attempts a side a fall this size is ordinary noise.
   */
  | { kind: 'dropped'; taskId: string; baseline: number; observed: number }
  /** Scored above the baseline: not a failure, but the baseline is now stale. */
  | { kind: 'improved'; taskId: string; baseline: number; observed: number }
  /** Held its baseline (within tolerance). */
  | { kind: 'held'; taskId: string; baseline: number; observed: number }
  /** Ran, but the baseline predates it — record a new baseline to start gating it. */
  | { kind: 'unrecorded'; taskId: string; observed: number }

/**
 * Grade a run against a baseline, one verdict per task scored.
 *
 * ONLY A COLLAPSE FAILS A SINGLE TASK. A task regresses when every baseline attempt
 * passed and none of the run's did. Anything less is `dropped` (reported) or `held`.
 *
 * Why not "fell by more than one attempt", which this once was: at three attempts a side
 * that is noise, not signal. The 2026-11-16 weekly Haiku run reded on semver-ranges (3/3
 * to 1/3) and extraction-job-stuck (2/3 to 0/3) with no product change since the baseline
 * was recorded that morning and the whole run held (76/87 against 77/87, p = 0.37). Pooled
 * over both runs those tasks sit near 4/6 and 2/6, where those scores turn up about 26%
 * and 30% of the time, and over 29 tasks the old rule reds roughly one weekly run in
 * three or four with nothing changed. No per-task test can do better at this sample size:
 * 3/3 against 0/3, the most extreme split there is, has a one-sided Fisher p of 0.05, so
 * a per-task test held to the run-wide 1% could never fire at all.
 *
 * A collapse can: a task at a true 95% scores 0/3 about once in 8,000 runs, under 0.3% a
 * week across every task baselined at 1. A broad fall, or one spread over tasks one or two
 * attempts each, is {@link compareAggregate}'s to catch, and that is the gate sized at 1%.
 *
 * Tasks present in the baseline but absent from `scores` are ignored rather than
 * failed: that is a task being deleted or renamed, which the suite's own
 * registration check already covers, and failing here would just duplicate it.
 *
 * A behavior probe (`probe:<id>`) is always `unrecorded`: probes are an A/B
 * instrument, so no baseline records them and the gate never grades one, even if a
 * hand-edited baseline carried its id.
 */
export function compareToBaseline(
  baseline: EvalBaseline,
  scores: TaskScore[],
  tolerance = DEFAULT_TOLERANCE
): BaselineVerdict[] {
  return scores.map((s) => {
    const base = isProbeResultId(s.taskId) ? undefined : baseline.tasks[s.taskId]
    if (base === undefined) return { kind: 'unrecorded', taskId: s.taskId, observed: s.passRate }
    if (base >= 1 && s.passRate <= 0) {
      return { kind: 'regressed', taskId: s.taskId, baseline: base, observed: s.passRate }
    }
    if (s.passRate < base - tolerance) {
      return { kind: 'dropped', taskId: s.taskId, baseline: base, observed: s.passRate }
    }
    if (s.passRate > base) return { kind: 'improved', taskId: s.taskId, baseline: base, observed: s.passRate }
    return { kind: 'held', taskId: s.taskId, baseline: base, observed: s.passRate }
  })
}

/** The regressions in a verdict list — non-empty means the benchmark failed. */
export function regressions(verdicts: BaselineVerdict[]): Extract<BaselineVerdict, { kind: 'regressed' }>[] {
  return verdicts.filter((v) => v.kind === 'regressed')
}

/**
 * The whole-run check's significance level: a run whose drop below the baseline has a
 * stratified mid-p under this fails (see stratifiedDropTest in stats.ts for the test).
 *
 * SIZED FOR A WEEKLY RUN. At 1% a run that changed nothing reds about once in two years
 * of weekly runs, rare enough that a red gets read rather than re-run. At 5% it would be
 * one every five months or so: the ignored-nightly failure compareToBaseline also avoids.
 *
 * WHAT IT CAN AND CANNOT SEE at 29 tasks x 3 attempts a side. Simulated with per-task
 * rates near the Haiku baseline's (79/87) and the same extra failure rate on every
 * attempt, it catches a true drop of
 *    4 points  9% of the time
 *    9 points  35%
 *   13 points  67%
 *   18 points  88%
 *   26 points  over 99%
 * so it is a backstop for a broad, sizeable fall, not a fine instrument: a change of a few
 * points is invisible to 87 attempts, and only more tasks or more attempts can see it
 * (smallestDetectableChange in stats.ts puts the 80% mark at about 18.5 points at three
 * attempts and 13.6 at five). The case the per-task check misses does fail it: 79/87 to
 * 70/87 as nine single flakes has a mid-p of 0.008. A task baselined at 0 adds nothing
 * (it can't fall), and one at 1/3 can fall by one attempt only.
 *
 * THE BASELINE IS REUSED. The 1% is an average over what the baseline itself happened to
 * draw, and every weekly run meets the same one, so a recording that came out above the
 * model's real rate raises the odds every week until it is re-recorded. In simulation,
 * one baseline in twenty carries about a 3% weekly false-red rate; a red that repeats on
 * the same few tasks with nothing changed is that, and the fix is a fresh recording.
 */
export const AGGREGATE_ALPHA = 0.01

/** The whole run against its baseline, over the tasks both scored. */
export interface AggregateVerdict {
  kind: 'regressed' | 'held'
  /** Tasks in both the baseline and the run: the only ones compared. */
  tasks: number
  /** Passes and attempts summed over those tasks, on each side. */
  baseline: { passes: number; attempts: number }
  run: { passes: number; attempts: number }
  /** Attempts per task on each side (the run's is a mean, should its tasks differ). */
  baselineAttempts: number
  runAttempts: number
  /** One-sided stratified mid-p, and the level it is held to. */
  p: number
  alpha: number
  /** The tasks that scored below their baseline rate, biggest fall first. */
  fell: Array<{ taskId: string; baseline: number; observed: number }>
}

/**
 * Grade the run as a whole: is it below the baseline by more than chance, across every
 * task it shares with it? Undefined when the two share no task.
 *
 * The per-task check names the one task that collapsed; this one sees what it can't, a
 * fall short of a collapse, whether in one task or spread thinly over many. Both sides are
 * compared as rates, task by task, so a run at a different attempt count (eval-ab runs
 * two against the three-attempt baselines) is graded fairly. Tasks the baseline predates
 * are left out, like `unrecorded` ones above, and so are baseline tasks this run skipped
 * and every behavior probe.
 */
export function compareAggregate(
  baseline: EvalBaseline,
  scores: TaskScore[],
  alpha = AGGREGATE_ALPHA
): AggregateVerdict | undefined {
  const shared = scores.filter(
    (s) => !isProbeResultId(s.taskId) && baseline.tasks[s.taskId] !== undefined && s.attempts > 0
  )
  if (shared.length === 0) return undefined
  const pairs = shared.map((s) => ({
    base: { passes: Math.round(baseline.tasks[s.taskId] * baseline.attempts), attempts: baseline.attempts },
    run: { passes: Math.round(s.passRate * s.attempts), attempts: s.attempts }
  }))
  const test = stratifiedDropTest(pairs)
  const sum = (side: 'base' | 'run', key: 'passes' | 'attempts'): number => pairs.reduce((n, p) => n + p[side][key], 0)
  const run = { passes: sum('run', 'passes'), attempts: sum('run', 'attempts') }
  // Rounded, so a third lost as 1 - 2/3 and as 1/3 - 0 rank as the tie they are.
  const lost = (f: { baseline: number; observed: number }): number => Math.round((f.baseline - f.observed) * 1e9)
  const fell = shared
    .filter((s) => s.passRate < baseline.tasks[s.taskId])
    .map((s) => ({ taskId: s.taskId, baseline: baseline.tasks[s.taskId], observed: s.passRate }))
    .sort((x, y) => lost(y) - lost(x) || (x.taskId < y.taskId ? -1 : 1))
  return {
    kind: test.p < alpha ? 'regressed' : 'held',
    tasks: shared.length,
    baseline: { passes: sum('base', 'passes'), attempts: sum('base', 'attempts') },
    run,
    baselineAttempts: baseline.attempts,
    runAttempts: run.attempts / shared.length,
    p: test.p,
    alpha,
    fell
  }
}

/**
 * Refuse to record a baseline that would gate nothing.
 *
 * A baseline of all zeros is a DEAD gate: `compareToBaseline` can never mark a
 * task regressed below 0, so the nightly would pass forever while still looking
 * like it was guarding quality — the exact false-green this suite exists to
 * prevent. And "the model solved literally nothing" is virtually always a
 * misconfiguration (an empty model id, a bad key, a provider outage) rather than
 * a true score worth freezing.
 *
 * This is deliberately a second line of defense behind `resolveEvalConfig`'s
 * validation: that one stops the known cause, this one stops the CONSEQUENCE of
 * any cause, including ones not thought of yet. It really happened — a
 * set-but-empty `HOUSTON_EVAL_MODEL` produced exactly this file.
 *
 * `errored` is the partial form of the same problem: failed attempts whose run
 * ended on an error event (the provider refused the call, the harness threw)
 * rather than on a result. Those zeros measure the failure, not the model, and
 * once frozen they can never regress. It really happened too: a provider account
 * ran out of credit two thirds of the way through a recording, and the last nine
 * tasks were written as 0 beside twenty real scores.
 *
 * `capped` is the same problem from the other side: attempts the per-attempt cost
 * cap stopped or told to wrap up (costCaps.ts). Even its reminder sits far above any
 * normal attempt, so one that reached it ran away, and was told to end, or ended on a
 * tools-off last step. Frozen as a failure, it would record a 0 for a task the model
 * can solve.
 *
 * A behavior probe never belongs in a baseline: probes are an A/B instrument, and the
 * gate ignores them. config.ts already refuses a recording that names any tasks; this
 * stops a probe row from reaching one some other way.
 */
export function assertRecordable(
  scores: TaskScore[],
  errored: Array<{ taskId: string; attempts: number }> = [],
  capped: Array<{ taskId: string; attempts: number }> = []
): void {
  if (scores.length === 0) {
    throw new Error('Refusing to record a baseline with no tasks — nothing ran.')
  }
  const probes = scores.filter((s) => isProbeResultId(s.taskId))
  if (probes.length > 0) {
    throw new Error(
      `Refusing to record a baseline with behavior probes in it (${probes.map((s) => s.taskId).join(', ')}). ` +
        'Probes are an A/B instrument and are never baselined: record with HOUSTON_EVAL_TASKS unset.'
    )
  }
  if (errored.length > 0) {
    const attempts = errored.reduce((n, e) => n + e.attempts, 0)
    throw new Error(
      [
        `Refusing to record a baseline: ${attempts} attempt(s) across ${errored.length} task(s) ended in a run error, not a result.`,
        `Tasks: ${errored.map((e) => e.taskId).join(', ')}`,
        '',
        'A provider or harness failure (no credit, a rate limit, an outage, a bad key) is not',
        'a score. Recording it would freeze those tasks at a number the model never earned,',
        'and a task frozen at 0 can never regress.',
        '',
        'Fix the cause and re-record.'
      ].join('\n')
    )
  }
  if (capped.length > 0) {
    const attempts = capped.reduce((n, e) => n + e.attempts, 0)
    throw new Error(
      [
        `Refusing to record a baseline: ${attempts} attempt(s) across ${capped.length} task(s) reached the per-attempt cost cap or its wrap-up reminder.`,
        `Tasks: ${capped.map((e) => e.taskId).join(', ')}`,
        '',
        'The cap is a runaway guard set far above a normal attempt, so a capped attempt is',
        'not a score: recording it would freeze a 0 for a task the model may well solve.',
        '',
        'Find what ran away (HOUSTON_EVAL_TRACE=1 prints every call), or raise',
        'HOUSTON_EVAL_MAX_COST_USD if this model genuinely needs more, and re-record.'
      ].join('\n')
    )
  }
  if (scores.every((s) => s.passRate === 0)) {
    throw new Error(
      [
        `Refusing to record a baseline where all ${scores.length} tasks scored 0.`,
        '',
        'Nothing passed, which is almost always a misconfiguration (empty/wrong model id,',
        'bad or missing API key, provider outage) rather than a real score. Recording it',
        'would produce a permanently dead gate: nothing can regress below zero, so the',
        'nightly could never fail again.',
        '',
        'Check the per-task run errors in the scorecard above, fix the cause, and re-record.'
      ].join('\n')
    )
  }
}

/** Build a baseline from a run's scores, ready to serialize and commit. */
export function recordBaseline(
  provider: string,
  model: string,
  attempts: number,
  scores: TaskScore[],
  now: Date,
  stamps: BaselineStamps = {}
): EvalBaseline {
  return {
    provider,
    model,
    attempts,
    recordedAt: now.toISOString().slice(0, 10),
    ...(stamps.promptHash ? { promptHash: stamps.promptHash } : {}),
    ...(stamps.reasoningEffort ? { reasoningEffort: stamps.reasoningEffort } : {}),
    ...(stamps.commit ? { commit: stamps.commit } : {}),
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

/**
 * True when a baseline gates nothing: every task recorded at 0, so no future
 * score can be marked regressed.
 *
 * Checked on LOAD as well as on record, because the two protect against different
 * things. `assertRecordable` stops this suite from writing one; this stops an
 * all-zero baseline that reached the repo some other way (committed by hand, or
 * swept in by a `git add -A` from a bad local run) from silently disabling the
 * only quality gate there is. A dead gate is worse than no gate: it reports green.
 */
export function isDeadBaseline(baseline: EvalBaseline): boolean {
  const rates = Object.values(baseline.tasks)
  return rates.length > 0 && rates.every((r) => r === 0)
}

/** Runtime shape check — a hand-edited baseline shouldn't fail as a mystery. */
export function isEvalBaseline(v: unknown): v is EvalBaseline {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  if (typeof b.provider !== 'string' || typeof b.model !== 'string') return false
  if (typeof b.attempts !== 'number' || typeof b.recordedAt !== 'string') return false
  for (const stamp of ['promptHash', 'reasoningEffort', 'commit']) {
    if (b[stamp] !== undefined && typeof b[stamp] !== 'string') return false
  }
  if (!b.tasks || typeof b.tasks !== 'object') return false
  return Object.values(b.tasks as Record<string, unknown>).every(
    (n) => typeof n === 'number' && n >= 0 && n <= 1
  )
}
