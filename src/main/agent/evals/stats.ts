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
 * level instead (see {@link signTest}), where that clustering can't flatter it,
 * and so does the baseline gate's whole-run check (see {@link stratifiedDropTest}).
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

/** One task on both sides of a two-sample comparison: the baseline (or run A) and the run (or B). */
export interface TaskPair {
  base: TaskOutcome
  run: TaskOutcome
}

export interface DropTest {
  /** Run passes across every task compared. */
  observed: number
  /** Run passes to expect if the run were exactly as good as the baseline on every task. */
  expected: number
  /**
   * Tasks with at least one pass and one fail across the two sides. Only these carry
   * any information: a task both sides always pass, or always fail, can't show a change.
   */
  informative: number
  /** One-sided mid-p: how surprising a run this far below the baseline would be if nothing had changed. */
  p: number
}

/** n choose k, by a running product (exact in a double for every size an eval reaches). */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let c = 1
  for (let i = 0; i < Math.min(k, n - k); i++) c = (c * (n - i)) / (i + 1)
  return c
}

/**
 * Did the run score lower than the baseline across the whole suite, beyond what
 * chance explains? One-sided, because only a drop fails a gate.
 *
 * TWO SAMPLES, NOT ONE. The baseline is not the model's true rate: it is one recorded
 * run, exactly as noisy as the run graded against it. Treating its numbers as exact
 * (a one-sample test of the run against them) leaves out half the noise, so it reds
 * more often than its level says.
 *
 * STRATIFIED BY TASK. Tasks differ far more from each other than attempts at one task
 * do: most pass every time, one never does. Each task is its own two-by-two table
 * (baseline or run, pass or fail), and only the differences inside a table count, so a
 * task that both sides always pass or always fail adds nothing and can't dilute the
 * rest. Conditioning on each task's total passes removes its difficulty from the test
 * altogether: if nothing changed, the run's share of a task's passes is hypergeometric
 * whatever that task's real rate (the Mantel-Haenszel construction, here with its exact
 * distribution, the sum of those hypergeometrics, rather than a normal approximation
 * that 29 tables of six attempts can't support). A pooled test of 79/87 against 70/87
 * would instead treat every attempt as interchangeable, and its variance would count the
 * spread between easy and hard tasks as noise.
 *
 * RATES, NOT COUNTS. The tables can have unequal rows, so a two-attempt run against a
 * three-attempt baseline just works: perfect scores on both sides read as no change, not
 * as 58 passes against 87.
 *
 * MID-P. The exact distribution is lumpy, so an exact p-value moves in steps and the
 * test's real false-red rate sits well below its level, which costs power a suite this
 * size can't spare. The mid-p counts half the probability of the observed total and keeps
 * the rate close to the level: simulated at 29 tasks x 3 attempts under several difficulty
 * profiles (and at 2 attempts against 3), a 1% gate on the mid-p false-reds 0.3% to 0.9%
 * of the time, under its level in every one, where one on the exact p-value does 0.1% to
 * 0.6%. The mid-p is not guaranteed to stay under its level the way the exact p-value is,
 * so a change to the suite's shape is worth simulating again.
 */
export function stratifiedDropTest(pairs: TaskPair[]): DropTest {
  // dist[s] is the probability that the run's passes total `offset + s` if nothing changed.
  let dist = [1]
  let offset = 0
  let observed = 0
  let expected = 0
  let informative = 0
  for (const { base, run } of pairs) {
    const n1 = base.attempts
    const n2 = run.attempts
    if (n1 <= 0 || n2 <= 0) continue
    const total = n1 + n2
    const passes = base.passes + run.passes
    const lo = Math.max(0, passes - n1)
    const hi = Math.min(n2, passes)
    const all = choose(total, n2)
    const pmf: number[] = []
    for (let x = lo; x <= hi; x++) pmf.push((choose(passes, x) * choose(total - passes, n2 - x)) / all)
    const next: number[] = new Array(dist.length + pmf.length - 1).fill(0)
    for (let i = 0; i < dist.length; i++) for (let j = 0; j < pmf.length; j++) next[i + j] += dist[i] * pmf[j]
    dist = next
    offset += lo
    observed += run.passes
    expected += (n2 * passes) / total
    if (hi > lo) informative++
  }
  if (informative === 0) return { observed, expected, informative, p: 1 }
  const at = observed - offset
  let p = dist[at] / 2
  for (let s = 0; s < at; s++) p += dist[s]
  return { observed, expected, informative, p: Math.min(1, p) }
}

/** The standard normal CDF, by the Abramowitz and Stegun erf approximation (error under 2e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
  const erf = 1 - poly * Math.exp(-x * x)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/** The z with `normalCdf(z) = q`, by bisection: slow next to a rational fit, and exact enough for a scorecard. */
export function normalQuantile(q: number): number {
  let lo = -12
  let hi = 12
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (normalCdf(mid) < q) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** The power the smallest detectable change is quoted at: four runs in five catch it. */
export const DETECTION_POWER = 0.8

export interface DetectionOptions {
  /** The per-attempt pass rate the change is measured from. Defaults to 0.5, the noisiest. */
  rate?: number
  /** Significance level. */
  alpha: number
  /** Split `alpha` over both tails, as a test that calls either direction does (the A/B). */
  twoSided?: boolean
  power?: number
}

/** Steps the scan below takes: a twentieth of a point. */
const SCAN_STEP = 0.0005

/**
 * The smallest true fall in the per-attempt pass rate, from `rate`, that comparing
 * `tasks` tasks at `attemptsA` attempts each with the same tasks at `attemptsB` detects
 * with the given power. Undefined when no fall in range gets there (too few attempts).
 *
 * A property of the design, not of any result: it says how big a change has to be before
 * a suite this size can see it, so a smaller move on the scorecard reads as the noise it
 * is. The normal approximation for two independent rates (pooled variance under "no
 * change", each side's own under the change), scanned in steps of a twentieth of a point.
 *
 * It tracks the gate's stratified test closely: with every task at one rate, simulation
 * at 29 tasks puts that test's 80% mark within a point of this at 50%, 90% and 97%, for
 * three attempts against three and against two alike. Spread between easy and hard tasks
 * only helps the stratified test on a fall (the Haiku baseline's own profile reaches 80%
 * at about 16 points, where this says 18.5 from its 91%), so read it as a slightly
 * cautious figure. The A/B's sign test counts tasks rather than attempts and needs a
 * little more.
 *
 * Always a fall, even for a two-sided test. A rise needs failures to fix, and on a suite
 * near its ceiling they sit on a few tasks: the formula, which assumes every task at the
 * same rate, would call a 9-point rise from 91% detectable, when a suite whose failures
 * sit on four tasks can't show any rise at all to a sign test. A design-level figure can't
 * know where the failures are, so it quotes the direction it gets right.
 */
export function smallestDetectableChange(
  tasks: number,
  attemptsA: number,
  attemptsB: number,
  opts: DetectionOptions
): number | undefined {
  const { rate = 0.5, alpha, twoSided = false, power = DETECTION_POWER } = opts
  const a = tasks * attemptsA
  const b = tasks * attemptsB
  if (!(a > 0 && b > 0)) return undefined
  const z = normalQuantile(1 - (twoSided ? alpha / 2 : alpha))
  for (let i = 1; i * SCAN_STEP <= rate + 1e-12; i++) {
    const d = i * SCAN_STEP
    const to = Math.max(0, rate - d)
    const pooled = (a * rate + b * to) / (a + b)
    const null0 = Math.sqrt(pooled * (1 - pooled) * (1 / a + 1 / b))
    const spread = Math.sqrt((rate * (1 - rate)) / a + (to * (1 - to)) / b)
    if (spread > 0 && normalCdf((d - z * null0) / spread) >= power) return d
  }
  return undefined
}

/**
 * The scorecard line for {@link smallestDetectableChange}: what a change has to be for
 * this design to see it, with the power, level and design it assumes.
 */
export function formatDetectable(tasks: number, attemptsA: number, attemptsB: number, opts: DetectionOptions): string {
  const d = smallestDetectableChange(tasks, attemptsA, attemptsB, opts)
  const n = (x: number): string => String(Math.round(x * 10) / 10)
  const sides =
    attemptsA === attemptsB
      ? `${n(attemptsA)} attempt${attemptsA === 1 ? '' : 's'} a side`
      : `${n(attemptsA)} and ${n(attemptsB)} attempts a side`
  const design = `${tasks} task${tasks === 1 ? '' : 's'}, ${sides}`
  const level = `${opts.twoSided ? 'two' : 'one'}-sided ${Math.round(opts.alpha * 1000) / 10}%`
  const power = pct(opts.power ?? DETECTION_POWER)
  return d === undefined
    ? `  smallest detectable change: none at ${power} power, ${level} (${design})`
    : `  smallest detectable change: about ${Math.round(d * 100)} points (${power} power, ${level}; ${design})`
}

/** `0.79` → `79%`, for the scorecard and comparison lines. */
export function pct(x: number): string {
  return `${Math.round(x * 100)}%`
}
