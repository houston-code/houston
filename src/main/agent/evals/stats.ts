/**
 * The statistics behind the eval scorecard and the A/B comparison. Pure, so the
 * node test project can pin every number.
 *
 * WHY A SCORE NEEDS AN INTERVAL. "23/24 attempts passed" reads as 96%, but 24
 * attempts can't tell 96% from 80%. A live run is a small sample of a noisy
 * model, and a bare mean invites reading a one-attempt wobble as a real change.
 * The Wilson interval says how wide the plausible range is, and stays sensible at
 * 0/n and n/n, where the textbook normal interval collapses to a zero-width lie.
 *
 * The interval here treats every attempt as independent. Attempts at the same
 * task are not (a hard task tends to fail every time), so the true uncertainty
 * about the suite is wider than printed. The A/B test therefore works at the task
 * level instead (see {@link signTest}), where that clustering can't flatter it.
 */

/** 1.96: the two-sided 95% normal quantile. */
const Z95 = 1.959963984540054

/** A closed interval in [0,1]. */
export interface Interval {
  low: number
  high: number
}

/** Wilson score interval for `successes` out of `n` Bernoulli trials (95% by default). */
export function wilson(successes: number, n: number, z = Z95): Interval {
  if (n <= 0) return { low: 0, high: 1 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

/**
 * Exact two-sided sign test: how likely a split at least this lopsided is when
 * neither side is really better. `wins` and `losses` are the tasks where one side
 * beat the other; ties carry no information and are left out by the caller.
 *
 * Deliberately blunt. With 8 tasks the smallest p it can reach is 2/2^8, and it
 * needs 6 wins with no losses to clear 0.05. That is the honest power of 8 tasks,
 * not a flaw to tune away: a test that called 4-1 significant would be lying.
 */
export function signTest(wins: number, losses: number): number {
  const n = wins + losses
  if (n === 0) return 1
  const k = Math.min(wins, losses)
  // P(X <= k) for X ~ Binomial(n, 1/2), summed with a running binomial coefficient.
  let coef = 1
  let tail = 0
  for (let i = 0; i <= k; i++) {
    tail += coef
    coef = (coef * (n - i)) / (i + 1)
  }
  return Math.min(1, (2 * tail) / 2 ** n)
}

/** One task's outcome: how many of its attempts passed. */
export interface TaskOutcome {
  passes: number
  attempts: number
}

export interface SuiteStats {
  tasks: number
  /** Tasks solved by at least one attempt (pass@k with k = attempts). */
  passAtK: number
  /** Tasks solved by EVERY attempt (pass^k): what a user who runs it once can count on. */
  passHatK: number
  /** Attempts that passed, across every task. */
  passes: number
  attempts: number
  /** passes / attempts, with its 95% Wilson interval. */
  rate: number
  interval: Interval
}

/**
 * Suite-level scores from per-task outcomes.
 *
 * pass@k and pass^k bracket the per-attempt rate from both sides. pass@k is the
 * ceiling (the model CAN do it), pass^k is the floor (it does it every time), and
 * a wide gap between them is flakiness that a mean alone would hide. With n = k
 * samples per task, the standard unbiased estimators reduce to "any passed" and
 * "all passed".
 */
export function suiteStats(outcomes: TaskOutcome[]): SuiteStats {
  const passes = outcomes.reduce((n, o) => n + o.passes, 0)
  const attempts = outcomes.reduce((n, o) => n + o.attempts, 0)
  return {
    tasks: outcomes.length,
    passAtK: outcomes.filter((o) => o.passes > 0).length,
    passHatK: outcomes.filter((o) => o.attempts > 0 && o.passes === o.attempts).length,
    passes,
    attempts,
    rate: attempts ? passes / attempts : 0,
    interval: wilson(passes, attempts)
  }
}

/** `0.79` → `79%`, for the scorecard and comparison lines. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}
