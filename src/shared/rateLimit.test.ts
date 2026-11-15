import { describe, expect, it } from 'vitest'
import { quotaIsLow, quotaStatusText, resetClock, throttleNotice } from './rateLimit'

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

describe('a usage-limit wait', () => {
  it('says when the limit resets, how long that is, and that the turn continues then', () => {
    const resetAt = new Date(2026, 10, 15, 9, 7).getTime()
    expect(resetClock(resetAt)).toBe('09:07')
    expect(throttleNotice({ waitMs: 2 * 3_600_000 + 15 * 60_000, resetAt }, '1/3')).toBe(
      'Usage limit reached. It resets at 09:07 (in 2h 15m); continuing then (1/3).'
    )
    expect(throttleNotice({ waitMs: 3_600_000, resetAt }, '2/3')).toContain('(in 1h)')
    expect(throttleNotice({ waitMs: 3_599_900, resetAt }, '2/3')).toContain('(in 1h)')
  })
})

describe('quotaStatusText reset time', () => {
  const now = new Date('2026-11-14T15:40:00').getTime()
  const at = new Date(now).toISOString()
  const resetAt = new Date(now + 120_000).toISOString()
  const clock = new Date(now + 120_000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  it('adds when the window refills once the quota is low', () => {
    expect(quotaStatusText({ remainingRequests: 2, limitRequests: 50, resetAt, at }, now)).toBe(`rate 2 req left, resets ${clock}`)
    expect(quotaStatusText({ throttled: true, resetAt, at }, now)).toBe(`rate limited, resets ${clock}`)
  })

  it('leaves it out while there is plenty left, or once it has passed', () => {
    expect(quotaStatusText({ remainingRequests: 40, limitRequests: 50, resetAt, at }, now)).toBe('rate 40 req left')
    expect(quotaStatusText({ remainingRequests: 2, limitRequests: 50, resetAt, at }, now + 200_000)).toBe('rate 2 req left')
    expect(quotaStatusText({ throttled: true, at }, now)).toBeNull()
  })
})
