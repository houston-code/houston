import { describe, it, expect } from 'vitest'
import { releaseDateFrom } from './release-date'

describe('releaseDateFrom', () => {
  it('reads unix seconds (OpenAI-style) and ISO strings (Anthropic)', () => {
    expect(releaseDateFrom(1_790_000_000)).toBe('2026-09-21')
    expect(releaseDateFrom('2026-08-31T00:00:00Z')).toBe('2026-08-31')
  })

  it('rejects placeholders, garbage, and other types', () => {
    expect(releaseDateFrom(0)).toBeUndefined()
    expect(releaseDateFrom('not a date')).toBeUndefined()
    expect(releaseDateFrom(undefined)).toBeUndefined()
    expect(releaseDateFrom({})).toBeUndefined()
  })
})
