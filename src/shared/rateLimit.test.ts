import { describe, expect, it } from 'vitest'
import { throttleNotice } from './rateLimit'

describe('throttleNotice', () => {
  it('says it was throttled, how long Houston waits, and the attempt', () => {
    expect(throttleNotice({ waitMs: 20_000 }, '2/6')).toBe('Rate limited by the provider. Retrying in 20s (2/6).')
  })

  it('names a wait the provider asked for, and the quota its headers reported', () => {
    expect(
      throttleNotice({ waitMs: 90_000, retryAfterMs: 90_000, remainingRequests: 0, remainingTokens: 1200 }, '1/6')
    ).toBe(
      'Rate limited by the provider. Retrying in 1m 30s, as the provider asked (1/6). 0 requests and 1,200 tokens left in this window.'
    )
  })

  it('rounds a short wait up to a second', () => {
    expect(throttleNotice({ waitMs: 200 }, 'attempt 3')).toContain('Retrying in 1s (attempt 3)')
  })
})
