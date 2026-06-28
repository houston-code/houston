import { describe, expect, it } from 'vitest'
import { tavilySearch, braveSearch, exaSearch, getSearchAdapter } from './websearch'

interface FakeResponseInit {
  ok?: boolean
  status?: number
}

interface FakeCall {
  url: string
  headers?: Record<string, string>
  body: unknown
}

function fakeFetch(body: unknown, init: FakeResponseInit = {}): {
  fetchImpl: typeof fetch
  calls: FakeCall[]
} {
  const calls: FakeCall[] = []
  // Tolerant of GET requests (no body), so it serves Brave as well as the
  // JSON-body POSTs (Tavily/Exa).
  const fetchImpl = (async (
    url: string,
    opts: { body?: string; headers?: Record<string, string> } = {}
  ) => {
    calls.push({
      url,
      headers: opts.headers,
      body: opts.body ? JSON.parse(opts.body) : undefined
    })
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
    }
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('tavilySearch', () => {
  it('formats the answer and results', async () => {
    const { fetchImpl } = fakeFetch({
      answer: 'The sky is blue.',
      results: [
        { title: 'Sky', url: 'https://ex.com/sky', content: 'Rayleigh scattering.' },
        { title: 'Color', url: 'https://ex.com/color', content: 'Wavelengths.' }
      ]
    })
    const out = await tavilySearch('why is the sky blue', 'tvly-x', { fetchImpl })
    expect(out).toContain('Answer: The sky is blue.')
    expect(out).toContain('Sky')
    expect(out).toContain('https://ex.com/sky')
    expect(out).toContain('Color')
  })

  it('sends the query, key, and clamps max_results into range', async () => {
    const { fetchImpl, calls } = fakeFetch({ results: [] })
    await tavilySearch('q', 'tvly-key', { fetchImpl, maxResults: 99 })
    expect(calls[0].url).toContain('tavily.com')
    expect(calls[0].body).toMatchObject({ query: 'q', api_key: 'tvly-key', max_results: 10 })
  })

  it('returns "No results." when empty', async () => {
    const { fetchImpl } = fakeFetch({ results: [] })
    expect(await tavilySearch('q', 'k', { fetchImpl })).toBe('No results.')
  })

  it('throws with a key hint on 401', async () => {
    const { fetchImpl } = fakeFetch('unauthorized', { ok: false, status: 401 })
    await expect(tavilySearch('q', 'bad', { fetchImpl })).rejects.toThrow(/401.*check the API key/s)
  })

  it('throws on other non-ok responses', async () => {
    const { fetchImpl } = fakeFetch('boom', { ok: false, status: 500 })
    await expect(tavilySearch('q', 'k', { fetchImpl })).rejects.toThrow(/Web search failed: 500/)
  })
})

describe('braveSearch', () => {
  it('formats web.results and sends the query, count, and token header', async () => {
    const { fetchImpl, calls } = fakeFetch({
      web: {
        results: [
          { title: 'Sky', url: 'https://ex.com/sky', description: 'Rayleigh scattering.' },
          { title: 'Color', url: 'https://ex.com/color', description: 'Wavelengths.' }
        ]
      }
    })
    const out = await braveSearch('why is the sky blue', 'BSA-key', { fetchImpl, maxResults: 3 })
    expect(out).toContain('Sky')
    expect(out).toContain('https://ex.com/sky')
    expect(out).toContain('Rayleigh scattering.')
    expect(out).toContain('Color')

    // GET with the query + clamped count in the URL and the key in the header.
    expect(calls[0].url).toContain('api.search.brave.com')
    expect(calls[0].url).toContain('q=why%20is%20the%20sky%20blue')
    expect(calls[0].url).toContain('count=3')
    expect(calls[0].body).toBeUndefined()
    expect(calls[0].headers?.['x-subscription-token']).toBe('BSA-key')
  })

  it('returns "No results." when empty', async () => {
    const { fetchImpl } = fakeFetch({ web: { results: [] } })
    expect(await braveSearch('q', 'k', { fetchImpl })).toBe('No results.')
  })

  it('hints to check the key on a 403', async () => {
    const { fetchImpl } = fakeFetch('forbidden', { ok: false, status: 403 })
    await expect(braveSearch('q', 'bad', { fetchImpl })).rejects.toThrow(/403.*check the API key/s)
  })
})

describe('exaSearch', () => {
  it('posts query + numResults with the key header and prefers highlights', async () => {
    const { fetchImpl, calls } = fakeFetch({
      results: [{ title: 'E', url: 'https://x.com', highlights: ['the key span'], text: 'full body' }]
    })
    const out = await exaSearch('hi', 'exa-key', { fetchImpl, maxResults: 4 })
    expect(out).toContain('E')
    expect(out).toContain('https://x.com')
    expect(out).toContain('the key span')

    expect(calls[0].url).toContain('api.exa.ai')
    expect(calls[0].body).toMatchObject({ query: 'hi', numResults: 4 })
    expect(calls[0].headers?.['x-api-key']).toBe('exa-key')
  })

  it('falls back to page text when a result has no highlights', async () => {
    const { fetchImpl } = fakeFetch({ results: [{ title: 'E', url: 'u', text: 'body text' }] })
    expect(await exaSearch('q', 'k', { fetchImpl })).toContain('body text')
  })

  it('returns "No results." when empty', async () => {
    const { fetchImpl } = fakeFetch({ results: [] })
    expect(await exaSearch('q', 'k', { fetchImpl })).toBe('No results.')
  })
})

describe('getSearchAdapter', () => {
  it('maps known ids to their adapters', () => {
    expect(getSearchAdapter('tavily')).toBe(tavilySearch)
    expect(getSearchAdapter('brave')).toBe(braveSearch)
    expect(getSearchAdapter('exa')).toBe(exaSearch)
  })

  it('falls back to Tavily for an unknown id', () => {
    expect(getSearchAdapter('nope')).toBe(tavilySearch)
  })
})
