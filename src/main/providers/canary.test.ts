import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderStreamEvent } from '@shared/agent'
import { CANARY_ATTEMPT_TIMEOUT_MS, CANARY_TEST_TIMEOUT_MS, runCanaryProbe } from './canary'

const DONE = { type: 'done' } as ProviderStreamEvent
const TEXT = { type: 'text', text: 'pong' } as ProviderStreamEvent

async function* events(...evs: ProviderStreamEvent[]): AsyncGenerator<ProviderStreamEvent> {
  for (const e of evs) yield e
}

/** A stream whose first `next()` settles via `pending`, like a connection that stalls. */
function stalled(pending: Promise<never>): AsyncIterable<ProviderStreamEvent> {
  return { [Symbol.asyncIterator]: () => ({ next: () => pending }) }
}

/** A stream that never yields and never ends, ignoring the abort. */
const hang = (): AsyncIterable<ProviderStreamEvent> => stalled(new Promise<never>(() => {}))

/** A stream that honors the abort the way the SDKs do: rejects with a generic abort error. */
const hangUntilAborted = (signal: AbortSignal): AsyncIterable<ProviderStreamEvent> =>
  stalled(
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
    )
  )

function apiError(status: number, message = `status ${status}`): Error {
  return Object.assign(new Error(message), { status })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('runCanaryProbe', () => {
  it('resolves true when the stream emits done', async () => {
    await expect(runCanaryProbe(() => events(TEXT, DONE))).resolves.toBe(true)
  })

  it('resolves false (without retrying) when the stream ends with no done', async () => {
    const open = vi.fn(() => events(TEXT))
    await expect(runCanaryProbe(open)).resolves.toBe(false)
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not retry a thrown 400: request-shape drift must red on the first try', async () => {
    const open = vi.fn(() => {
      throw apiError(400, 'Unknown parameter: thinkingConfig')
    })
    await expect(runCanaryProbe(open)).rejects.toThrow('Unknown parameter')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('does not retry an in-band 404 error event (retired model)', async () => {
    const open = vi.fn(() =>
      events({ type: 'error', message: 'model not found', status: 404 } as ProviderStreamEvent)
    )
    await expect(runCanaryProbe(open)).rejects.toMatchObject({ message: 'model not found', status: 404 })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('retries a transient 503 once and passes when the retry succeeds', async () => {
    let calls = 0
    const onRetry = vi.fn()
    const open = (): AsyncIterable<ProviderStreamEvent> => {
      calls++
      if (calls === 1) throw apiError(503, 'overloaded')
      return events(DONE)
    }
    await expect(runCanaryProbe(open, { onRetry })).resolves.toBe(true)
    expect(calls).toBe(2)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('retries an in-band 429 error event', async () => {
    const open = vi
      .fn<(s: AbortSignal) => AsyncIterable<ProviderStreamEvent>>()
      .mockReturnValueOnce(events({ type: 'error', message: 'rate limited', status: 429 } as ProviderStreamEvent))
      .mockReturnValueOnce(events(DONE))
    await expect(runCanaryProbe(open)).resolves.toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('gives up after the retry budget on a persistent transient failure', async () => {
    const open = vi.fn(() => {
      throw apiError(500, 'internal')
    })
    await expect(runCanaryProbe(open, { maxRetries: 1 })).rejects.toThrow('internal')
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('times out a stalled stream as a retryable 408 and retries it', async () => {
    vi.useFakeTimers()
    const open = vi
      .fn<(s: AbortSignal) => AsyncIterable<ProviderStreamEvent>>()
      .mockImplementationOnce(() => hang())
      .mockImplementationOnce(() => events(DONE))
    const p = runCanaryProbe(open, { attemptTimeoutMs: 1_000 })
    await vi.runAllTimersAsync()
    await expect(p).resolves.toBe(true)
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('aborts the stalled attempt and reports the timeout, not the SDK abort error', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const open = (signal: AbortSignal): AsyncIterable<ProviderStreamEvent> => {
      signals.push(signal)
      return hangUntilAborted(signal)
    }
    const p = runCanaryProbe(open, { attemptTimeoutMs: 1_000, maxRetries: 1 })
    const settled = expect(p).rejects.toMatchObject({ message: 'no response within 1000ms', status: 408 })
    await vi.runAllTimersAsync()
    await settled
    expect(signals).toHaveLength(2)
    expect(signals.every((s) => s.aborted)).toBe(true)
  })

  it('aborts the attempt signal after a successful attempt so nothing is left open', async () => {
    let seen: AbortSignal | undefined
    await runCanaryProbe((s) => {
      seen = s
      return events(DONE)
    })
    expect(seen?.aborted).toBe(true)
  })

  it('sizes the vitest timeout to cover every attempt plus the longest backoff', () => {
    expect(CANARY_TEST_TIMEOUT_MS).toBeGreaterThan(2 * CANARY_ATTEMPT_TIMEOUT_MS + 60_000)
  })
})
