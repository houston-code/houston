import { describe, expect, it } from 'vitest'
import { highlightsFor, RELEASE_HIGHLIGHTS } from './update'

describe('highlightsFor', () => {
  it('returns the bundled highlights for a known version', () => {
    expect(highlightsFor('0.1.0')).toBe(RELEASE_HIGHLIGHTS['0.1.0'])
  })

  it('returns null for a version with no recorded highlights', () => {
    expect(highlightsFor('9.9.9')).toBeNull()
  })

  it('keeps every entry short enough for the small popup (≤ 2 lines)', () => {
    for (const [version, text] of Object.entries(RELEASE_HIGHLIGHTS)) {
      expect(text.length, version).toBeLessThanOrEqual(160)
      expect(text.split('\n').length, version).toBeLessThanOrEqual(2)
    }
  })
})
