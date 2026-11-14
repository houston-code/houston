import { describe, expect, it } from 'vitest'
import { DEFAULT_COMPACTION_THRESHOLD } from './defaults'
import {
  COMPACTION_WINDOW_FRACTION,
  DEFAULT_COMPACTION_PERCENT,
  DEFAULT_COMPACTION_TOKENS,
  automaticCompactionThreshold,
  compactionLimitFrom,
  compactionMode,
  compactionThresholdNote,
  resolveCompactionThreshold,
  withCompactionMode
} from './compactionThreshold'

describe('resolveCompactionThreshold with a user limit', () => {
  it('uses the automatic threshold with no user limit', () => {
    expect(resolveCompactionThreshold({}, 200_000)).toBe(160_000)
    expect(resolveCompactionThreshold({}, null)).toBe(DEFAULT_COMPACTION_THRESHOLD)
    expect(automaticCompactionThreshold(200_000)).toBe(Math.floor(200_000 * COMPACTION_WINDOW_FRACTION))
  })

  it('lets a share of the window lower the threshold', () => {
    expect(resolveCompactionThreshold({ percent: 50 }, 200_000)).toBe(100_000)
    expect(resolveCompactionThreshold({ percent: 1 }, 16_000)).toBe(160)
  })

  it('caps a share or a token count above the safety margin at the automatic threshold', () => {
    expect(resolveCompactionThreshold({ percent: 95 }, 200_000)).toBe(160_000)
    expect(resolveCompactionThreshold({ percent: 100 }, 200_000)).toBe(160_000)
    expect(resolveCompactionThreshold({ percent: 400 }, 200_000)).toBe(160_000)
    expect(resolveCompactionThreshold({ tokens: 500_000 }, 200_000)).toBe(160_000)
    expect(resolveCompactionThreshold(500_000, 200_000)).toBe(160_000)
  })

  it('takes the lower of a token count and a share when both are set', () => {
    expect(resolveCompactionThreshold({ tokens: 80_000, percent: 50 }, 200_000)).toBe(80_000)
    expect(resolveCompactionThreshold({ tokens: 150_000, percent: 25 }, 200_000)).toBe(50_000)
  })

  it('applies a token count as written when the window is unknown, and ignores a share', () => {
    expect(resolveCompactionThreshold({ tokens: 250_000 }, null)).toBe(250_000)
    expect(resolveCompactionThreshold({ percent: 50 }, null)).toBe(DEFAULT_COMPACTION_THRESHOLD)
    expect(resolveCompactionThreshold({ percent: 50, tokens: 30_000 }, null)).toBe(30_000)
  })

  it('turns compaction off for 0 in either field, and ignores non-finite values', () => {
    expect(resolveCompactionThreshold({ percent: 0 }, 200_000)).toBe(0)
    expect(resolveCompactionThreshold({ tokens: 0, percent: 50 }, 200_000)).toBe(0)
    expect(resolveCompactionThreshold({ percent: -3 }, null)).toBe(0)
    expect(resolveCompactionThreshold({ percent: Number.NaN }, 200_000)).toBe(160_000)
    expect(resolveCompactionThreshold({ tokens: Number.POSITIVE_INFINITY }, 200_000)).toBe(160_000)
  })

  it('reads the limit from the two settings fields', () => {
    expect(compactionLimitFrom({ compactionThreshold: 5, compactionThresholdPercent: 7 })).toEqual({
      tokens: 5,
      percent: 7
    })
    expect(compactionLimitFrom({})).toEqual({ tokens: undefined, percent: undefined })
  })
})

describe('resolveCompactionThreshold with a long-context price tier', () => {
  it('keeps the user limit as one more minimum under the tier', () => {
    // Tier at 272k: the automatic threshold sits at 244.8k on a 1M window.
    expect(resolveCompactionThreshold({}, 1_000_000, 272_000)).toBe(244_800)
    expect(resolveCompactionThreshold({ percent: 50 }, 1_000_000, 272_000)).toBe(244_800)
    expect(resolveCompactionThreshold({ percent: 10 }, 1_000_000, 272_000)).toBe(100_000)
    expect(resolveCompactionThreshold({ tokens: 30_000 }, null, 272_000)).toBe(30_000)
  })

  it('names the tier in the note', () => {
    expect(compactionThresholdNote({}, 1_000_000, 272_000)).toContain('under the long-context price tier')
    expect(compactionThresholdNote({ percent: 50 }, 1_000_000, 272_000)).toContain(
      'is capped under the long-context price tier'
    )
    expect(compactionThresholdNote({ percent: 10 }, 1_000_000, 272_000)).toContain('your setting: 10% of the window')
  })
})

describe('compactionThresholdNote', () => {
  it('names the automatic threshold and where it comes from', () => {
    expect(compactionThresholdNote({}, 200_000)).toBe(
      'Compacts automatically at about 160k tokens (automatic: 80% of the window).'
    )
    expect(compactionThresholdNote({}, null)).toContain("window is unknown")
  })

  it("names the user's setting, and says when the margin capped it", () => {
    expect(compactionThresholdNote({ percent: 50 }, 200_000)).toBe(
      'Compacts automatically at about 100k tokens (your setting: 50% of the window).'
    )
    expect(compactionThresholdNote({ tokens: 500_000 }, 200_000)).toContain('is capped at the 80% safety margin')
    expect(compactionThresholdNote({ tokens: 60_000, percent: 50 }, 200_000)).toContain(
      '50% of the window or 60k tokens'
    )
    expect(compactionThresholdNote({ percent: 50 }, null)).toContain('automatic')
  })

  it('says when compaction is off', () => {
    expect(compactionThresholdNote({ tokens: 0 }, 200_000)).toMatch(/^Automatic compaction is off/)
  })
})

describe('compaction mode', () => {
  it('reads which field is in use', () => {
    expect(compactionMode({})).toBe('auto')
    expect(compactionMode({ compactionThreshold: 0 })).toBe('off')
    expect(compactionMode({ compactionThresholdPercent: 0 })).toBe('off')
    expect(compactionMode({ compactionThresholdPercent: 40 })).toBe('percent')
    expect(compactionMode({ compactionThreshold: 90_000 })).toBe('tokens')
  })

  it('switches mode, storing only the field the mode uses', () => {
    const base = { other: 1, compactionThreshold: 70_000, compactionThresholdPercent: 30 }
    expect(withCompactionMode(base, 'auto')).toEqual({ other: 1 })
    expect(withCompactionMode(base, 'off')).toEqual({ other: 1, compactionThreshold: 0 })
    expect(withCompactionMode(base, 'percent')).toEqual({ other: 1, compactionThresholdPercent: 30 })
    expect(withCompactionMode(base, 'tokens')).toEqual({ other: 1, compactionThreshold: 70_000 })
    expect(withCompactionMode({ compactionThreshold: 0 }, 'percent')).toEqual({
      compactionThresholdPercent: DEFAULT_COMPACTION_PERCENT
    })
    expect(withCompactionMode({}, 'tokens')).toEqual({ compactionThreshold: DEFAULT_COMPACTION_TOKENS })
    for (const mode of ['auto', 'percent', 'tokens', 'off'] as const) {
      expect(compactionMode(withCompactionMode({}, mode))).toBe(mode)
    }
  })
})
