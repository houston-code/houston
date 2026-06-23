import { describe, it, expect } from 'vitest'
import { isRetryableError, backoffDelayMs, abortableSleep } from './retry'

describe('isRetryableError', () => {
  it('retries 429 / 408 / 409 / 5xx by status', () => {
    expect(isRetryableError({ status: 429 })).toBe(true)
    expect(isRetryableError({ status: 408 })).toBe(true)
    expect(isRetryableError({ status: 409 })).toBe(true)
    expect(isRetryableError({ status: 500 })).toBe(true)
    expect(isRetryableError({ status: 503 })).toBe(true)
  })

  it('does not retry ordinary 4xx', () => {
    expect(isRetryableError({ status: 400 })).toBe(false)
    expect(isRetryableError({ status: 401 })).toBe(false)
    expect(isRetryableError({ status: 404 })).toBe(false)
  })

  it('retries transient messages when there is no status', () => {
    expect(isRetryableError(new Error('Overloaded'))).toBe(true)
    expect(isRetryableError(new Error('rate limit exceeded'))).toBe(true)
    expect(isRetryableError(new Error('socket hang up'))).toBe(true)
    expect(isRetryableError(new Error('fetch failed'))).toBe(true)
    expect(isRetryableError(new Error('529 overloaded'))).toBe(true)
  })

  it('does not retry a generic error', () => {
    expect(isRetryableError(new Error('invalid api key'))).toBe(false)
    expect(isRetryableError(new Error('old_string was not found'))).toBe(false)
  })
})

describe('backoffDelayMs', () => {
  it('grows exponentially and is capped', () => {
    const d1 = backoffDelayMs(1, { rand: () => 0 })
    const d2 = backoffDelayMs(2, { rand: () => 0 })
    const d3 = backoffDelayMs(3, { rand: () => 0 })
    expect(d2).toBeGreaterThan(d1)
    expect(d3).toBeGreaterThan(d2)
    expect(backoffDelayMs(20, { rand: () => 1 })).toBeLessThanOrEqual(15_000)
  })

  it('applies jitter within [50%, 100%] of the window', () => {
    expect(backoffDelayMs(1, { base: 1000, rand: () => 0 })).toBe(500)
    expect(backoffDelayMs(1, { base: 1000, rand: () => 1 })).toBe(1000)
  })
})

describe('abortableSleep', () => {
  it('resolves immediately when already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const start = Date.now()
    await abortableSleep(10_000, ac.signal)
    expect(Date.now() - start).toBeLessThan(500)
  })
})
