import { describe, expect, it } from 'vitest'
import { pct, signTest, suiteStats, wilson } from './stats'

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

describe('pct', () => {
  it('rounds to a whole percent', () => {
    expect(pct(0.8619)).toBe('86%')
    expect(pct(1)).toBe('100%')
  })
})
