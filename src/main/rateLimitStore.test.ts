import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetRateLimits, noteThrottle, onRateLimitChange, rateLimitSnapshot, recordRateLimit } from './rateLimitStore'

describe('rateLimitStore', () => {
  afterEach(() => _resetRateLimits())

  it('keeps the newest state per provider and tells listeners', () => {
    const seen = vi.fn()
    onRateLimitChange(seen)
    noteThrottle('anthropic', { waitMs: 1000, remainingRequests: 3 }, 100)
    noteThrottle('openai', { waitMs: 1000, remainingTokens: 50 }, 200)
    noteThrottle('anthropic', { waitMs: 1000, remainingRequests: 0 }, 300)
    expect(rateLimitSnapshot()).toEqual([
      { providerId: 'anthropic', observedAt: 300, remainingRequests: 0, source: 'retry' },
      { providerId: 'openai', observedAt: 200, remainingTokens: 50, source: 'retry' }
    ])
    expect(seen).toHaveBeenCalledTimes(3)
  })

  it('ignores an older observation, a throttle with nothing in it, and an unknown provider', () => {
    const seen = vi.fn()
    noteThrottle('anthropic', { waitMs: 1000, remainingRequests: 2 }, 500)
    onRateLimitChange(seen)
    recordRateLimit({ providerId: 'anthropic', observedAt: 400, remainingRequests: 9, source: 'headers' })
    noteThrottle('anthropic', { waitMs: 1000 }, 600)
    noteThrottle(undefined, { waitMs: 1000, remainingRequests: 1 }, 700)
    expect(rateLimitSnapshot()).toEqual([{ providerId: 'anthropic', observedAt: 500, remainingRequests: 2, source: 'retry' }])
    expect(seen).not.toHaveBeenCalled()
  })

  it('lets a richer source replace a retry-fed state', () => {
    noteThrottle('anthropic', { waitMs: 1000, remainingRequests: 0 }, 100)
    recordRateLimit({ providerId: 'anthropic', observedAt: 200, remainingRequests: 40, resetAt: 900, source: 'headers' })
    expect(rateLimitSnapshot()[0]).toMatchObject({ remainingRequests: 40, resetAt: 900, source: 'headers' })
  })

  it('stops telling a listener that unsubscribed', () => {
    const seen = vi.fn()
    const off = onRateLimitChange(seen)
    off()
    noteThrottle('anthropic', { waitMs: 1, remainingRequests: 1 }, 1)
    expect(seen).not.toHaveBeenCalled()
  })
})
