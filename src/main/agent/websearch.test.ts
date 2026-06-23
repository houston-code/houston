import { describe, expect, it } from 'vitest'
import { tavilySearch } from './websearch'

interface FakeResponseInit {
  ok?: boolean
  status?: number
}

function fakeFetch(body: unknown, init: FakeResponseInit = {}): {
  fetchImpl: typeof fetch
  calls: { url: string; body: unknown }[]
} {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl = (async (url: string, opts: { body: string }) => {
    calls.push({ url, body: JSON.parse(opts.body) })
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
