/**
 * Web search via Tavily (https://tavily.com), an LLM-oriented search API: one
 * POST returns clean results plus an optional synthesized answer. The key is
 * stored encrypted (secrets store) and read only in the main process.
 *
 * `fetchImpl` is injectable so the formatting/error handling can be unit-tested
 * without a network call.
 */

const TAVILY_URL = 'https://api.tavily.com/search'

interface TavilyResult {
  title?: string
  url?: string
  content?: string
}

interface TavilyResponse {
  answer?: string
  results?: TavilyResult[]
}

export interface SearchOptions {
  signal?: AbortSignal
  maxResults?: number
  fetchImpl?: typeof fetch
}

export async function tavilySearch(
  query: string,
  apiKey: string,
  opts: SearchOptions = {}
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch
  const maxResults = Math.min(Math.max(1, Math.floor(opts.maxResults ?? 5)), 10)

  const res = await doFetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: true,
      search_depth: 'basic'
    }),
    signal: opts.signal
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    const hint = res.status === 401 ? ' (check the API key in Settings)' : ''
    throw new Error(`Web search failed: ${res.status}${hint} ${detail.slice(0, 200)}`.trim())
  }

  const data = (await res.json()) as TavilyResponse
  const results = data.results ?? []
  if (results.length === 0 && !data.answer) return 'No results.'

  const lines: string[] = []
  if (data.answer) lines.push(`Answer: ${data.answer.trim()}`, '')
  for (const r of results) {
    lines.push(`- ${r.title ?? '(untitled)'}\n  ${r.url ?? ''}\n  ${(r.content ?? '').trim().slice(0, 300)}`)
  }
  return lines.join('\n').trim()
}
