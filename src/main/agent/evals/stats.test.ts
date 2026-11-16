import { describe, expect, it } from 'vitest'
import {
  collapsePower,
  formatDetectable,
  normalCdf,
  normalQuantile,
  pct,
  signTest,
  smallestDetectableChange,
  stratifiedDropTest,
  suiteStats,
  wilson,
  type TaskPair
} from './stats'

/** A task scored `base` of `bn` attempts in the baseline and `run` of `rn` in the run. */
const pair = (base: number, run: number, bn = 3, rn = 3): TaskPair => ({
  base: { passes: base, attempts: bn },
  run: { passes: run, attempts: rn }
})

/** A Haiku-shaped baseline: 25 tasks at 3/3, two at 1/3, one at 2/3, one at 0/3 (79/87). */
const HAIKU = [...Array<number>(25).fill(3), 1, 1, 2, 0]

/** The run: the baseline with the first `k` tasks (all perfect ones) one attempt down. */
const flakes = (k: number): number[] => HAIKU.map((b, i) => (i < k ? b - 1 : b))

describe('wilson', () => {
  // Reference values from the closed form, rounded to 4 places.
  it('matches the textbook interval for a middling rate', () => {
    const { low, high } = wilson(5, 10)
    expect(low).toBeCloseTo(0.2366, 4)
    expect(high).toBeCloseTo(0.7634, 4)
  })

  // Where the normal interval collapses to [1,1]: 24/24 is not proof of 100%.
  it('keeps a real width at a perfect score', () => {
    const { low, high } = wilson(24, 24)
    expect(high).toBeCloseTo(1, 12)
    expect(low).toBeCloseTo(0.862, 4)
  })

  it('keeps a real width at zero', () => {
    const { low, high } = wilson(0, 3)
    expect(low).toBeCloseTo(0, 12)
    expect(high).toBeCloseTo(0.5615, 4)
  })

  it('narrows as the sample grows', () => {
    const small = wilson(8, 10)
    const large = wilson(80, 100)
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  it('is the whole range when there is no sample', () => {
    expect(wilson(0, 0)).toEqual({ low: 0, high: 1 })
  })
})

describe('signTest', () => {
  it('is 1 when nothing changed', () => {
    expect(signTest(0, 0)).toBe(1)
  })

  it('is 1 for an even split', () => {
    expect(signTest(3, 3)).toBe(1)
  })

  // The power of 8 tasks, as documented: 6-0 clears 0.05, 5-0 and 7-1 do not.
  it('needs a near-sweep to reach significance', () => {
    expect(signTest(6, 0)).toBeCloseTo(2 / 64, 10)
    expect(signTest(6, 0)).toBeLessThan(0.05)
    expect(signTest(5, 0)).toBeGreaterThan(0.05)
    expect(signTest(7, 1)).toBeCloseTo(18 / 256, 10)
    expect(signTest(7, 1)).toBeGreaterThan(0.05)
  })

  it('is symmetric in wins and losses', () => {
    expect(signTest(1, 9)).toBe(signTest(9, 1))
  })
})

describe('suiteStats', () => {
  it('brackets the per-attempt rate between pass^k and pass@k', () => {
    const s = suiteStats([
      { passes: 3, attempts: 3 },
      { passes: 2, attempts: 3 },
      { passes: 0, attempts: 3 }
    ])
    expect(s).toMatchObject({ tasks: 3, passAtK: 2, passHatK: 1, passes: 5, attempts: 9 })
    expect(s.rate).toBeCloseTo(5 / 9, 10)
    expect(s.interval).toEqual(wilson(5, 9))
  })

  it('reports an empty run as zero with an uninformative interval', () => {
    expect(suiteStats([])).toEqual({
      tasks: 0,
      passAtK: 0,
      passHatK: 0,
      passes: 0,
      attempts: 0,
      rate: 0,
      interval: { low: 0, high: 1 }
    })
  })
})

describe('stratifiedDropTest', () => {
  // Closed forms: one task, 3 attempts a side. If nothing changed, the run's share of the
  // task's passes is hypergeometric; mid-p counts half the observed outcome.
  it('matches the hypergeometric by hand for a single task', () => {
    // 3/3 then 0/3: P(run gets none of the 3 passes) = C(3,3)/C(6,3) = 1/20.
    expect(stratifiedDropTest([pair(3, 0)])).toEqual({ observed: 0, expected: 1.5, informative: 1, p: 1 / 40 })
    // 3/3 then 2/3: the one fail lands on the run's side half the time.
    expect(stratifiedDropTest([pair(3, 2)]).p).toBeCloseTo(0.25, 12)
  })

  it('multiplies across tasks that each sit at their extreme', () => {
    const six = Array.from({ length: 6 }, () => pair(3, 2))
    expect(stratifiedDropTest(six).p).toBeCloseTo(0.5 * 0.5 ** 6, 12)
  })

  // A task both sides always pass, or always fail, can't show a change, and must not dilute one.
  it('ignores tasks with no variation', () => {
    expect(stratifiedDropTest([pair(3, 3), pair(0, 0)])).toEqual({ observed: 3, expected: 3, informative: 0, p: 1 })
    const diluted = [pair(3, 0), ...Array.from({ length: 20 }, () => pair(3, 3))]
    expect(stratifiedDropTest(diluted).p).toBeCloseTo(1 / 40, 12)
  })

  it('reads a run better than its baseline as no drop at all', () => {
    expect(stratifiedDropTest([pair(0, 3)]).p).toBeCloseTo(1 - 1 / 40, 12)
  })

  // Rates, not counts: 2 attempts against 3 is a table with unequal rows.
  it('compares a two-attempt run with a three-attempt baseline by rate', () => {
    // Every task perfect on both sides: 87 passes against 58 is no change at all.
    expect(stratifiedDropTest(Array.from({ length: 29 }, () => pair(3, 2, 3, 2)))).toMatchObject({ informative: 0, p: 1 })
    // 3/3 then 1/2: the one fail of 5 lands in the run's 2 slots with probability 2/5.
    expect(stratifiedDropTest([pair(3, 1, 3, 2)]).p).toBeCloseTo(0.2, 12)
  })

  // Reference values from an independent implementation (a Map-based convolution).
  it('flags the drop the per-task tolerance misses, and not an A/A wobble', () => {
    // 79/87 to 70/87 as nine single flakes: every task within its tolerance.
    expect(stratifiedDropTest(HAIKU.map((b, i) => pair(b, flakes(9)[i]))).p).toBeCloseTo(0.0082421875, 10)
    // 79/87 to 77/87, the size of a real A/A run.
    expect(stratifiedDropTest(HAIKU.map((b, i) => pair(b, flakes(2)[i]))).p).toBeCloseTo(0.236, 10)
  })

  it('skips a task with no attempts on a side', () => {
    expect(stratifiedDropTest([pair(3, 0, 3, 0), pair(3, 0)]).p).toBeCloseTo(1 / 40, 12)
  })
})

describe('normalCdf and normalQuantile', () => {
  it('match the familiar values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 7)
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 6)
    expect(normalCdf(-2.3263478740408408)).toBeCloseTo(0.01, 6)
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 4)
    expect(normalQuantile(0.99)).toBeCloseTo(2.326348, 4)
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 4)
  })
})

describe('smallestDetectableChange', () => {
  const gate = { alpha: 0.01 }

  // The numbers the gate's doc quotes, for 29 tasks at the Haiku baseline's 79/87. Each
  // was also checked against a simulation of the stratified test itself (see stats.ts).
  it('puts the weekly gate’s 80% mark at about 18.5 points at three attempts and 13.6 at five', () => {
    expect(smallestDetectableChange(29, 3, 3, { ...gate, rate: 79 / 87 })).toBeCloseTo(0.185, 3)
    expect(smallestDetectableChange(29, 5, 5, { ...gate, rate: 79 / 87 })).toBeCloseTo(0.136, 3)
    // eval-ab's shape: two attempts against the three-attempt baseline.
    expect(smallestDetectableChange(29, 3, 2, { ...gate, rate: 79 / 87 })).toBeCloseTo(0.207, 3)
  })

  it('is widest in the middle and narrows toward a ceiling', () => {
    const at = (rate: number): number => smallestDetectableChange(29, 3, 3, { ...gate, rate })!
    expect(at(0.5)).toBeCloseTo(0.232, 3)
    expect(at(0.97)).toBeLessThan(at(0.9))
    expect(at(0.9)).toBeLessThan(at(0.5))
  })

  it('needs a bigger change with fewer attempts or fewer tasks', () => {
    const full = smallestDetectableChange(29, 3, 3, { ...gate, rate: 0.9 })!
    expect(smallestDetectableChange(29, 3, 2, { ...gate, rate: 0.9 })!).toBeGreaterThan(full)
    expect(smallestDetectableChange(29, 2, 3, { ...gate, rate: 0.9 })!).toBeGreaterThan(full)
    expect(smallestDetectableChange(20, 3, 3, { ...gate, rate: 0.9 })!).toBeGreaterThan(full)
  })

  // Two-sided spends the level on both tails, so each tail needs a bigger change.
  it('needs more when the test is two-sided', () => {
    const one = smallestDetectableChange(29, 3, 3, { alpha: 0.05, rate: 0.9 })!
    const two = smallestDetectableChange(29, 3, 3, { alpha: 0.05, rate: 0.9, twoSided: true })!
    expect(two).toBeGreaterThan(one)
    expect(two).toBe(smallestDetectableChange(29, 3, 3, { alpha: 0.025, rate: 0.9 }))
  })

  it('defaults to the noisiest rate and to 80% power', () => {
    expect(smallestDetectableChange(29, 3, 3, gate)).toBe(smallestDetectableChange(29, 3, 3, { ...gate, rate: 0.5 }))
    expect(smallestDetectableChange(29, 3, 3, { ...gate, power: 0.9 })!).toBeGreaterThan(
      smallestDetectableChange(29, 3, 3, gate)!
    )
  })

  it('is undefined when nothing in range reaches the power', () => {
    expect(smallestDetectableChange(1, 1, 1, gate)).toBeUndefined()
    expect(smallestDetectableChange(0, 3, 3, gate)).toBeUndefined()
    // Nothing to fall from.
    expect(smallestDetectableChange(29, 3, 3, { ...gate, rate: 0 })).toBeUndefined()
    // The whole fall from 5% is caught about a quarter of the time: genuinely out of reach.
    expect(smallestDetectableChange(29, 3, 3, { ...gate, rate: 0.05 })).toBeUndefined()
  })

  // Near a floor the normal approximation puts even the whole fall short of 80%, which
  // the stratified test catches 88% of the time, so that fall is checked exactly.
  it('quotes the whole fall from a low rate when the gate would catch it', () => {
    expect(collapsePower(29, 3, 3, 0.1, 0.01)).toBeCloseTo(0.878, 3)
    expect(smallestDetectableChange(29, 3, 3, { ...gate, rate: 0.1 })).toBe(0.1)
    // Above that rate the scan finds a fall short of the whole one, as before.
    expect(smallestDetectableChange(29, 3, 3, { ...gate, rate: 0.12 })!).toBeLessThan(0.12)
  })
})

describe('collapsePower', () => {
  // Two tasks of one attempt a side: a task the baseline passed has half a chance of its
  // pass landing on the run's side, so one such task gives a mid-p of 1/4 and two of 1/8.
  it('matches a case worked by hand', () => {
    expect(collapsePower(2, 1, 1, 0.3, 0.2)).toBeCloseTo(0.3 ** 2, 12)
    expect(collapsePower(2, 1, 1, 0.3, 0.1)).toBe(0)
  })

  // Every baseline draw over four tasks, each graded by the real test against a run that
  // never passes, weighted by its chance.
  it('is the power of the stratified test against a run that never passes', () => {
    const rate = 0.3
    const alpha = 0.04
    const chance = (k: number): number => [1, 3, 3, 1][k] * rate ** k * (1 - rate) ** (3 - k)
    let power = 0
    for (let draw = 0; draw < 4 ** 4; draw++) {
      const ks = [0, 1, 2, 3].map((t) => Math.floor(draw / 4 ** t) % 4)
      const test = stratifiedDropTest(ks.map((k) => pair(k, 0, 3, 2)))
      if (test.p < alpha) power += ks.reduce((n, k) => n * chance(k), 1)
    }
    expect(power).toBeGreaterThan(0)
    expect(collapsePower(4, 3, 2, rate, alpha)).toBeCloseTo(power, 12)
  })

  it('rounds a fractional mean of attempts, and stops at a lower bound when the products outgrow it', () => {
    expect(collapsePower(4, 3, 2.2, 0.3, 0.04)).toBe(collapsePower(4, 3, 2, 0.3, 0.04))
    const exact = collapsePower(29, 3, 3, 0.1, 0.01)
    const bounded = collapsePower(29, 3, 3, 0.1, 0.01, 2)
    expect(bounded).toBeGreaterThanOrEqual(0)
    expect(bounded).toBeLessThan(exact)
  })
})

describe('formatDetectable', () => {
  it('states the change with the power, level and design it assumes', () => {
    expect(formatDetectable(29, 3, 3, { alpha: 0.01, rate: 79 / 87 })).toBe(
      '  smallest detectable change: about 19 points (80% power, one-sided 1%; 29 tasks, 3 attempts a side)'
    )
    expect(formatDetectable(20, 3, 2, { alpha: 0.05, rate: 0.87, twoSided: true })).toMatch(
      /^ {2}smallest detectable change: about \d+ points \(80% power, two-sided 5%; 20 tasks, 3 and 2 attempts a side\)$/
    )
  })

  it('says so when the design can see nothing', () => {
    expect(formatDetectable(1, 1, 1, { alpha: 0.01 })).toBe(
      '  smallest detectable change: none at 80% power, one-sided 1% (1 task, 1 attempt a side)'
    )
  })

  // A weak model's baseline: the gate does see a collapse from it.
  it('quotes the whole fall from a low rate rather than none', () => {
    expect(formatDetectable(29, 3, 3, { alpha: 0.01, rate: 0.1 })).toBe(
      '  smallest detectable change: about 10 points (80% power, one-sided 1%; 29 tasks, 3 attempts a side)'
    )
  })
})

describe('pct', () => {
  it('rounds to a whole percent', () => {
    expect(pct(0.8619)).toBe('86%')
    expect(pct(1)).toBe('100%')
  })
})
