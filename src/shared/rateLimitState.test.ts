import { describe, expect, it } from 'vitest'
import { rateLimitLine, remainingText, resetText, stateFromThrottle } from './rateLimitState'

const clock = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const now = new Date('2026-11-14T15:40:00').getTime()

describe('rateLimitState', () => {
  it('keeps what a throttle reported, with the reset the provider asked for', () => {
    expect(stateFromThrottle('anthropic', { waitMs: 20_000, retryAfterMs: 60_000, remainingRequests: 0, remainingTokens: 1200 }, now)).toEqual({
      providerId: 'anthropic',
      observedAt: now,
      remainingRequests: 0,
      remainingTokens: 1200,
      resetAt: now + 60_000,
      source: 'retry'
    })
  })

  it('keeps nothing from a throttle that reported nothing, and never treats the backoff as a reset', () => {
    expect(stateFromThrottle('openai', { waitMs: 5000 }, now)).toBeNull()
  })

  it('words what is left and when it resets', () => {
    const s = stateFromThrottle('openai', { waitMs: 1, retryAfterMs: 120_000, remainingRequests: 1, remainingTokens: 4000 }, now)!
    expect(remainingText(s)).toBe('1 request and 4,000 tokens left')
    expect(resetText(s, now)).toBe(`resets ${clock(now + 120_000)}`)
    // Once the reset has passed it is no longer news.
    expect(resetText(s, now + 121_000)).toBe('')
    expect(rateLimitLine(s, now)).toBe(`1 request and 4,000 tokens left, resets ${clock(now + 120_000)} (as of ${clock(now)})`)
    const resetOnly = stateFromThrottle('openai', { waitMs: 1, retryAfterMs: 1000 }, now)!
    expect(rateLimitLine(resetOnly, now + 5000)).toBe(`Rate limited (as of ${clock(now)})`)
  })
})
