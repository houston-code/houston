/**
 * Dollar caps on eval runs: one per attempt, enforced by the loop, and one per run,
 * enforced here between attempts.
 *
 * WHY TWO, AND WHY THE PER-ATTEMPT ONE IS SO HIGH. Wall-clock alone bounded a live
 * run before this, and a model that loops on expensive turns can spend a lot in the
 * twenty minutes an attempt is allowed. The per-attempt cap is the loop's own
 * `maxCostUsd` (budget.ts, the CLI's `--max-cost`), and that cap is NOT inert: a
 * positive one tells the model to wrap up at 80% of it and turns its final step
 * tools-off. A cap near a normal attempt's cost would therefore change how normal
 * attempts end, and the scores with them. So it is a runaway guard sized far above
 * the costliest attempt seen, never an average.
 *
 * The run cap is the spend limit a person sets for a whole run. It never cuts an
 * attempt short: once the run has spent it, the remaining attempts are not started
 * and the run FAILS, naming every task it didn't finish. It must never quietly
 * grade a smaller set instead, because `compareToBaseline` ignores a task missing
 * from the scores, so a skipped task would pass the gate.
 */

/**
 * The per-attempt cap when HOUSTON_EVAL_MAX_COST_USD is unset.
 *
 * Sized from the archived A/B run records (96 runs of claude-haiku-5-5, 20 harder
 * tasks, 2 attempts each, so 1,920 per-task costs summed over 2 attempts). The mean
 * attempt cost about $0.011 and the costliest task, two attempts together, $0.255 (a
 * semver-ranges run of 15 minutes; shell-allow-rule-bypass peaks at $0.235), so the
 * worst single attempt was at most about 24 times the mean. Pricier models, scaled by
 * that same worst-to-mean ratio:
 *
 *   claude-haiku-5-5  mean ~$0.011  worst seen  <= $0.26
 *   gpt-6.1-sol       mean ~$0.10   (a full 87-attempt run costs $8-9)   worst ~$2.40
 *   claude-opus-*     mean ~$0.16-0.32 (eval-live.yml: about 14x a Haiku run)  worst ~$4-8
 *
 * At $20 the wrap-up reminder fires at $16, at least twice the worst inferred attempt
 * of every model with a baseline here, while an attempt that loops on large turns until
 * its time limit is still stopped at a known price. Fable / Mythos and the pro tiers
 * price above Opus: raise HOUSTON_EVAL_MAX_COST_USD for them.
 */
export const DEFAULT_ATTEMPT_MAX_COST_USD = 20

/** The caps a run executes under, stamped in its scorecard and run record. */
export interface CostCaps {
  /** Per-attempt cap, passed to the loop as `maxCostUsd` (HOUSTON_EVAL_MAX_COST_USD). */
  attemptUsd: number
  /** Per-run cap (HOUSTON_EVAL_MAX_RUN_USD); absent means none. */
  runUsd?: number
}

/** An amount spent: `$5.12`, or enough digits to tell a sub-cent amount from zero. */
export function formatUsd(usd: number): string {
  return `$${usd >= 0.01 || usd === 0 ? usd.toFixed(2) : usd.toPrecision(2)}`
}

/**
 * A cap exactly as set (`$20`, `$0.012`). Never rounded: {@link capsLabel} is how a
 * comparison tells two runs' caps apart, and $0.012 and $0.014 are different caps.
 */
export function formatCap(usd: number): string {
  return `$${usd}`
}

/** `$20/attempt, $5/run`: the caps as one stamp, equal exactly when the caps are. */
export function capsLabel(caps: CostCaps | undefined): string | undefined {
  if (!caps) return undefined
  return `${formatCap(caps.attemptUsd)}/attempt, ${caps.runUsd === undefined ? 'no run cap' : `${formatCap(caps.runUsd)}/run`}`
}

/**
 * A run's spend against its cap, and the tasks the cap kept from finishing. One per
 * run: the driver adds every attempt's cost as it ends.
 */
export class RunSpend {
  private spent = 0
  private readonly skippedIds: string[] = []

  constructor(readonly capUsd: number | undefined) {}

  get spentUsd(): number {
    return this.spent
  }

  /** Tasks with at least one attempt the cap kept from starting, in run order. */
  get skipped(): readonly string[] {
    return this.skippedIds
  }

  add(costUsd: number): void {
    this.spent += costUsd
  }

  /** Whether the run has spent its cap, so no further attempt may start. Never without a cap. */
  reached(): boolean {
    return this.capUsd !== undefined && this.spent >= this.capUsd
  }

  skip(taskId: string): void {
    if (!this.skippedIds.includes(taskId)) this.skippedIds.push(taskId)
  }
}

/** One task's attempts, and whether all of them ran. */
export interface AttemptsOutcome<R> {
  results: R[]
  /** False when the run cap stopped the task before all its attempts ran. */
  complete: boolean
}

/**
 * Run a task's attempts one at a time, starting each only while the run is under its
 * cap. The attempt that crosses the cap runs to its end (its own per-attempt cap bounds
 * it), so a run overshoots by at most one attempt. A task cut short is recorded as
 * skipped: graded on fewer attempts than its baseline, its pass rate would mean nothing.
 */
export async function runAttempts<R extends { costUsd: number }>(
  taskId: string,
  attempts: number,
  spend: RunSpend,
  attempt: () => Promise<R>
): Promise<AttemptsOutcome<R>> {
  const results: R[] = []
  for (let i = 0; i < attempts; i++) {
    if (spend.reached()) {
      spend.skip(taskId)
      return { results, complete: false }
    }
    const r = await attempt()
    spend.add(r.costUsd)
    results.push(r)
  }
  return { results, complete: true }
}

/** Why one task's test fails when the run cap stopped it. */
export function runCapTaskError(taskId: string, ran: number, attempts: number, spend: RunSpend): string {
  const what = ran === 0 ? 'was not run' : `stopped after ${ran} of ${attempts} attempts`
  return (
    `Task "${taskId}" ${what}: the run reached its cost cap (HOUSTON_EVAL_MAX_RUN_USD=${spend.capUsd}) ` +
    `after spending ${formatUsd(spend.spentUsd)}. It is not graded, and the run fails.`
  )
}

/**
 * The run-level failure once the cap has stopped tasks, naming every one of them. The
 * scorecard and run record are written first; this keeps a cut-short run from reading
 * as a pass and from recording a baseline without those tasks.
 */
export function runCapError(spend: RunSpend): string {
  const skipped = spend.skipped
  return [
    `The run reached its cost cap (HOUSTON_EVAL_MAX_RUN_USD=${spend.capUsd}) after spending ` +
      `${formatUsd(spend.spentUsd)}, so ${skipped.length} task(s) did not run all their attempts and were not graded:`,
    `  ${skipped.join(', ')}`,
    '',
    'A run that skips tasks is not a pass: the baseline gate ignores a task missing from',
    'the scores. Raise the cap, or narrow the run with HOUSTON_EVAL_TASKS, and run again.'
  ].join('\n')
}

/**
 * A task's attempts as its test grades them: every one, or a throw (runCapTaskError) when
 * the run cap kept any from starting. Graded on fewer attempts than its baseline, the pass
 * rate would mean nothing, and left out quietly the task would pass the gate (a task
 * missing from the scores is never compared). `ran` sees the attempts that did run either
 * way, so their prompt hashes still reach the run's stamp.
 */
export async function runTaskAttempts<R extends { costUsd: number }>(
  taskId: string,
  attempts: number,
  spend: RunSpend,
  attempt: () => Promise<R>,
  ran?: (results: R[]) => void
): Promise<R[]> {
  const { results, complete } = await runAttempts(taskId, attempts, spend, attempt)
  ran?.(results)
  if (!complete) throw new Error(runCapTaskError(taskId, results.length, attempts, spend))
  return results
}

/**
 * The end of a run, once its scorecard and run record are written: fails the run when the
 * cap kept any task from finishing, naming all of them (runCapError), and only otherwise
 * goes on to `record`, the baseline step. Each skipped task's own test has already failed;
 * this fails the run as a whole, before a recording could write a baseline without them
 * (the gate reads a task missing from a baseline as unrecorded, not failed).
 */
export function finishRun(spend: RunSpend, record: () => void): void {
  if (spend.skipped.length) throw new Error(runCapError(spend))
  record()
}

/**
 * Whether the caps can hold for `model`. A model with no known price costs 0 to the loop,
 * which means "unknown", so neither cap can stop it. Returns a warning to print when only
 * the default per-attempt cap is affected, and throws when either cap was set explicitly
 * (`attemptCapSet` for HOUSTON_EVAL_MAX_COST_USD, a `runUsd` for HOUSTON_EVAL_MAX_RUN_USD):
 * a spend limit someone set must not pass as enforced when it can't be.
 */
export function capsEnforceable(
  model: string,
  priced: boolean,
  caps: CostCaps,
  { attemptCapSet = false }: { attemptCapSet?: boolean } = {}
): string | undefined {
  if (priced) return undefined
  const why = `Houston has no price for ${model}, so its cost reads as 0 and the eval cost caps can't be enforced for it.`
  const set = [
    ...(attemptCapSet ? ['HOUSTON_EVAL_MAX_COST_USD'] : []),
    ...(caps.runUsd !== undefined ? ['HOUSTON_EVAL_MAX_RUN_USD'] : [])
  ]
  if (set.length) {
    throw new Error(`${why} Unset ${set.join(' and ')}, or add the model's price to src/shared/model-facts.ts.`)
  }
  return `${why} Watch the run's spend with the provider.`
}
