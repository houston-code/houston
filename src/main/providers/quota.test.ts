import { afterEach, describe, expect, it } from 'vitest'
import type { Provider, ProviderStreamEvent } from '@shared/agent'
import {
  onProviderQuota,
  providerQuota,
  providerQuotas,
  quotaFromHeaders,
  recordResponseQuota,
  resetProviderQuotas,
  withQuotaScope
} from './quota'
import { idleTimeoutFetch } from './idle-fetch'

afterEach(() => resetProviderQuotas())

const NOW = new Date('2026-11-14T12:00:00Z')

describe('quotaFromHeaders', () => {
  it('reads Anthropic and OpenAI-style ratelimit headers', () => {
    expect(
      quotaFromHeaders(
        new Headers({
          'anthropic-ratelimit-requests-remaining': '49',
          'anthropic-ratelimit-requests-limit': '50',
          'anthropic-ratelimit-tokens-remaining': '120000',
          'anthropic-ratelimit-tokens-limit': '400000'
        }),
        200,
        NOW
      )
    ).toEqual({ remainingRequests: 49, limitRequests: 50, remainingTokens: 120000, limitTokens: 400000, at: NOW.toISOString() })
    expect(
      quotaFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': '9', 'x-ratelimit-remaining-tokens': '7.9' }), 429, NOW)
    ).toEqual({ remainingRequests: 9, remainingTokens: 7, throttled: true, at: NOW.toISOString() })
  })

  it('is null without a remaining count, and ignores garbage', () => {
    expect(quotaFromHeaders(new Headers({ 'x-ratelimit-limit-requests': '100' }), 200)).toBeNull()
    expect(quotaFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': 'lots' }), 200)).toBeNull()
    expect(quotaFromHeaders(new Headers({ 'x-ratelimit-remaining-requests': '-1' }), 200)).toBeNull()
  })
})

describe('recording quota per provider', () => {
  const headers = (n: number): Headers => new Headers({ 'x-ratelimit-remaining-requests': String(n) })

  /** A provider whose stream fetches through the shared wrapper before each event. */
  const fetching = (fetch: () => Promise<Response>): Provider => ({
    async *streamChat(): AsyncGenerator<ProviderStreamEvent> {
      await idleTimeoutFetch(1000, fetch)('https://api.example.test/v1/chat')
      yield { type: 'text', text: 'a' }
      await idleTimeoutFetch(1000, fetch)('https://api.example.test/v1/chat')
      yield { type: 'done', stopReason: 'end_turn' }
    }
  })

  it("records each response's quota under the provider whose stream made it", async () => {
    let n = 10
    const p = withQuotaScope('openai', fetching(async () => new Response('{}', { headers: headers(n--) })))
    const seen: Array<[string, number | undefined]> = []
    const off = onProviderQuota((id, q) => seen.push([id, q.remainingRequests]))
    for await (const e of p.streamChat({ model: 'm', messages: [] })) void e
    off()
    expect(seen).toEqual([
      ['openai', 10],
      ['openai', 9]
    ])
    expect(providerQuota('openai')?.remainingRequests).toBe(9)
    expect(Object.keys(providerQuotas())).toEqual(['openai'])
  })

  it('keeps two providers apart, even when their streams interleave', async () => {
    const a = withQuotaScope('a', fetching(async () => new Response('{}', { headers: headers(1) })))
    const b = withQuotaScope('b', fetching(async () => new Response('{}', { headers: headers(2) })))
    const drain = async (p: Provider): Promise<void> => {
      for await (const e of p.streamChat({ model: 'm', messages: [] })) void e
    }
    await Promise.all([drain(a), drain(b)])
    expect(providerQuota('a')?.remainingRequests).toBe(1)
    expect(providerQuota('b')?.remainingRequests).toBe(2)
  })

  it('records nothing outside a provider scope or without headers', async () => {
    recordResponseQuota(headers(3), 200)
    recordResponseQuota(undefined, 200)
    await idleTimeoutFetch(1000, async () => new Response('{}', { headers: headers(4) }))('https://x.test/')
    expect(providerQuotas()).toEqual({})
  })

  it('scopes a provider-run web search too, and passes every other method through', async () => {
    const inner: Provider = {
      async *streamChat() {
        yield { type: 'done', stopReason: 'end_turn' }
      },
      webSearch: async () => {
        await idleTimeoutFetch(1000, async () => new Response('{}', { headers: headers(5) }))('https://x.test/')
        return { hits: [] }
      }
    }
    const p = withQuotaScope('anthropic', inner)
    expect(await p.webSearch!({ model: 'm', query: 'q', maxResults: 1 })).toEqual({ hits: [] })
    expect(providerQuota('anthropic')?.remainingRequests).toBe(5)
    expect(withQuotaScope('x', { streamChat: inner.streamChat }).webSearch).toBeUndefined()
  })

  it('never fails a request because a listener threw', async () => {
    const off = onProviderQuota(() => {
      throw new Error('boom')
    })
    const p = withQuotaScope('openai', fetching(async () => new Response('{}', { headers: headers(1) })))
    const events: string[] = []
    for await (const e of p.streamChat({ model: 'm', messages: [] })) events.push(e.type)
    off()
    expect(events).toEqual(['text', 'done'])
  })
})
