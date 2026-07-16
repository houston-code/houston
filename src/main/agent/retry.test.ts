import { describe, it, expect, vi } from 'vitest'
import {
  abortableSleep,
  backoffDelayMs,
  isRetryableError,
  isToolsUnsupportedError,
  MAX_PROVIDER_RETRIES,
  ProviderError,
  providerStreamError,
  retryAfterHintMs,
  retryDelayMs,
  withProviderRetry
} from './retry'

/** A thrown SDK-shaped error: a status, and optionally the headers it came with. */
function apiError(status: number, message = 'boom', headers?: Record<string, string>): Error {
  return Object.assign(new Error(message), { status, ...(headers ? { headers } : {}) })
}

describe('isToolsUnsupportedError', () => {
  it('matches the Ollama "does not support tools" 400', () => {
    expect(
      isToolsUnsupportedError({
        status: 400,
        message: 'registry.ollama.ai/library/llama2:latest does not support tools'
      })
    ).toBe(true)
  })

  it('matches other phrasings and a status-less error', () => {
    expect(isToolsUnsupportedError({ status: 422, message: 'tool calling is not supported' })).toBe(true)
    expect(isToolsUnsupportedError(new Error('This model does not support tools'))).toBe(true)
  })

  it('ignores unrelated errors and non-4xx statuses', () => {
    expect(isToolsUnsupportedError({ status: 400, message: 'prompt is too long' })).toBe(false)
    expect(isToolsUnsupportedError(new Error('invalid api key'))).toBe(false)
    // A 5xx that happens to contain the phrase isn't a model-capability problem.
    expect(isToolsUnsupportedError({ status: 503, message: 'does not support tools' })).toBe(false)
  })
})

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

  it('does not retry a permanent error that merely contains a bare 5xx number', () => {
    // No status field, so the message regex runs; "550"/"512" here are token counts.
    expect(isRetryableError(new Error('Requested 550 completions exceeds the maximum'))).toBe(false)
    expect(isRetryableError(new Error('maximum context length is 512 tokens'))).toBe(false)
    // A 5xx presented as an HTTP status still retries via the message.
    expect(isRetryableError(new Error('server responded with HTTP 503'))).toBe(true)
    expect(isRetryableError(new Error('status 500 internal error'))).toBe(true)
  })
})

describe('abortableSleep', () => {
  it('removes its abort listener on the normal timeout path (no leak)', async () => {
    vi.useFakeTimers()
    try {
      const ac = new AbortController()
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
      const p = abortableSleep(50, ac.signal)
      await vi.advanceTimersByTimeAsync(50)
      await p
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    } finally {
      vi.useRealTimers()
    }
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

describe('MAX_PROVIDER_RETRIES', () => {
  it('spends a budget that actually reaches the backoff cap', () => {
    // The budget and the curve are one design, not two constants: the last retry should
    // be the first to hit the 15s cap. This failing means either the budget shrank back
    // under the curve (leaving the cap unreachable, which is the bug this fixed) or the
    // curve moved out from under the budget.
    expect(backoffDelayMs(MAX_PROVIDER_RETRIES, { rand: () => 1 })).toBe(15_000)
    expect(backoffDelayMs(MAX_PROVIDER_RETRIES - 1, { rand: () => 1 })).toBeLessThan(15_000)
  })

  it('rides out a provider blip without parking the run', () => {
    const total = Array.from({ length: MAX_PROVIDER_RETRIES }, (_, i) =>
      backoffDelayMs(i + 1, { rand: () => 1 })
    ).reduce((a, b) => a + b, 0)
    // Long enough to outlast a typical overload, short enough that a user watching a
    // dead provider isn't left guessing. The old budget of 3 totalled ~5.6s.
    expect(total).toBeGreaterThan(30_000)
    expect(total).toBeLessThan(45_000)
  })
})

describe('retryAfterHintMs', () => {
  it('reads delta-seconds from a Headers', () => {
    expect(retryAfterHintMs({ headers: new Headers({ 'retry-after': '30' }) })).toBe(30_000)
  })

  it('reads delta-seconds from a plain record, case-insensitively', () => {
    expect(retryAfterHintMs({ headers: { 'Retry-After': '5' } })).toBe(5_000)
  })

  it('reads the HTTP-date form relative to now', () => {
    const now = Date.parse('2026-07-16T12:00:00Z')
    const at = new Date(now + 20_000).toUTCString()
    expect(retryAfterHintMs({ headers: { 'retry-after': at } }, now)).toBe(20_000)
  })

  it('treats an already-passed HTTP-date as no wait', () => {
    const now = Date.parse('2026-07-16T12:00:00Z')
    const at = new Date(now - 60_000).toUTCString()
    expect(retryAfterHintMs({ headers: { 'retry-after': at } }, now)).toBe(0)
  })

  it('clamps an absurd window so a server cannot park a run on it', () => {
    expect(retryAfterHintMs({ headers: { 'retry-after': '86400' } })).toBe(60_000)
  })

  it('prefers the value an in-band ProviderError already carries', () => {
    const err = new ProviderError('overloaded', { status: 503, retryAfterMs: 2_000 })
    expect(retryAfterHintMs(err)).toBe(2_000)
  })

  it('returns undefined when the server named no window', () => {
    expect(retryAfterHintMs(new Error('boom'))).toBeUndefined()
    expect(retryAfterHintMs({ headers: { 'retry-after': 'not-a-date' } })).toBeUndefined()
    expect(retryAfterHintMs({ headers: {} })).toBeUndefined()
    expect(retryAfterHintMs(null)).toBeUndefined()
  })

  it('survives a headers object whose get() is not a Headers get()', () => {
    const hostile = {
      headers: {
        get() {
          throw new Error('nope')
        }
      }
    }
    expect(retryAfterHintMs(hostile)).toBeUndefined()
  })
})

describe('retryDelayMs', () => {
  it('waits the window the server named when it exceeds our guess', () => {
    expect(retryDelayMs(apiError(429, 'slow down', { 'retry-after': '30' }), 1, { rand: () => 1 })).toBe(
      30_000
    )
  })

  it('never dips below the backoff, so Retry-After: 0 cannot hot-loop', () => {
    const err = apiError(503, 'overloaded', { 'retry-after': '0' })
    expect(retryDelayMs(err, 3, { rand: () => 1 })).toBe(backoffDelayMs(3, { rand: () => 1 }))
  })

  it('falls back to plain backoff when there is no Retry-After', () => {
    expect(retryDelayMs(new Error('overloaded'), 2, { rand: () => 1 })).toBe(1_600)
  })
})

describe('providerStreamError', () => {
  it('keeps an in-band failure retryable by carrying its status across the rethrow', () => {
    const err = providerStreamError({ message: 'The server had an error', status: 500 })
    expect(isRetryableError(err)).toBe(true)
    expect(err.message).toBe('The server had an error')
  })

  it('leaves a status-less in-band failure to the message rules', () => {
    // The exact regression this fixed: with no status riding along, this prose was all
    // the classifier had, and it matches nothing — so a failed stream was never retried.
    expect(isRetryableError(providerStreamError({ message: 'OpenAI Responses API error' }))).toBe(false)
  })
})

describe('withProviderRetry', () => {
  it('retries a transient failure and discards the failed attempt', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const p = withProviderRetry(async () => {
        attempts++
        if (attempts < 3) throw apiError(503, 'overloaded')
        return `ok-${attempts}`
      })
      await vi.runAllTimersAsync()
      await expect(p).resolves.toBe('ok-3')
      expect(attempts).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry a non-transient failure', async () => {
    let attempts = 0
    await expect(
      withProviderRetry(async () => {
        attempts++
        throw apiError(401, 'bad key')
      })
    ).rejects.toThrow('bad key')
    expect(attempts).toBe(1)
  })

  it('gives up after maxRetries and rethrows the last failure', async () => {
    vi.useFakeTimers()
    try {
      let attempts = 0
      const p = withProviderRetry(
        async () => {
          attempts++
          throw apiError(503, 'overloaded')
        },
        { maxRetries: 2 }
      )
      const settled = expect(p).rejects.toThrow('overloaded')
      await vi.runAllTimersAsync()
      await settled
      expect(attempts).toBe(3) // the initial attempt plus two retries
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops on abort rather than spending the rest of the budget', async () => {
    const ac = new AbortController()
    let attempts = 0
    await expect(
      withProviderRetry(
        async () => {
          attempts++
          ac.abort()
          throw apiError(503, 'overloaded')
        },
        { signal: ac.signal }
      )
    ).rejects.toThrow('overloaded')
    expect(attempts).toBe(1)
  })

  it('reports each retry to the caller', async () => {
    vi.useFakeTimers()
    try {
      const seen: number[] = []
      let attempts = 0
      const p = withProviderRetry(
        async () => {
          attempts++
          if (attempts < 3) throw apiError(503, 'overloaded')
          return 'ok'
        },
        { onRetry: (n) => seen.push(n) }
      )
      await vi.runAllTimersAsync()
      await p
      expect(seen).toEqual([1, 2])
    } finally {
      vi.useRealTimers()
    }
  })
})
