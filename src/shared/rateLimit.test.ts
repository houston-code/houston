import { describe, expect, it } from 'vitest'
import { quotaIsLow, quotaStatusText, throttleNotice } from './rateLimit'

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

describe('quotaStatusText / quotaIsLow', () => {
  const at = '2026-11-14T00:00:00Z'

  it('names what is left, compactly, or nothing', () => {
    expect(quotaStatusText({ remainingRequests: 45, remainingTokens: 12_345, at })).toBe('rate 45 req · 12k tok left')
    expect(quotaStatusText({ remainingTokens: 1_500_000, at })).toBe('rate 1.5M tok left')
    expect(quotaStatusText({ remainingRequests: 1200, at })).toBe('rate 1.2k req left')
    expect(quotaStatusText({ at })).toBeNull()
    expect(quotaStatusText(undefined)).toBeNull()
  })

  it('is low under a tenth of the allowance, or when throttled', () => {
    expect(quotaIsLow({ remainingRequests: 4, limitRequests: 50, at })).toBe(true)
    expect(quotaIsLow({ remainingRequests: 40, limitRequests: 50, remainingTokens: 10, limitTokens: 1000, at })).toBe(true)
    expect(quotaIsLow({ remainingRequests: 40, limitRequests: 50, at })).toBe(false)
    // No allowance to compare to: only a throttle counts.
    expect(quotaIsLow({ remainingRequests: 1, at })).toBe(false)
    expect(quotaIsLow({ throttled: true, at })).toBe(true)
    expect(quotaIsLow(undefined)).toBe(false)
  })
})
