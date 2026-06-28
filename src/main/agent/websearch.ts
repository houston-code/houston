/**
 * Web search adapters. Each provider turns one query into a single formatted
 * string (an optional synthesized answer plus title/url/snippet lines), so the
 * agent-facing result is uniform no matter which backend the user picked. The
 * provider catalog (ids, labels, key storage) lives in `@shared/search`; this
 * module holds the HTTP calls, keyed by the same ids via {@link getSearchAdapter}.
 *
 * `fetchImpl` is injectable so formatting/error handling can be unit-tested
 * without a network call. Keys are stored encrypted (secrets store) and read only
 * in the main process.
 */

export interface SearchOptions {
  signal?: AbortSignal
  maxResults?: number
  fetchImpl?: typeof fetch
}

/** A signature shared by every provider adapter. */
export type SearchFn = (query: string, apiKey: string, opts?: SearchOptions) => Promise<string>

/** One normalized hit, regardless of which provider produced it. */
interface SearchHit {
  title?: string
  url?: string
  content?: string
}

/** Clamp the requested result count into the tool's advertised 1–10 range. */
function clampResults(n: number | undefined): number {
  return Math.min(Math.max(1, Math.floor(n ?? 5)), 10)
}

/** Shared non-OK handling: surface the status, hint at the key on auth failures. */
async function failIfNotOk(res: { ok: boolean; status: number; text: () => Promise<string> }): Promise<void> {
  if (res.ok) return
  const detail = await res.text().catch(() => '')
  const hint = res.status === 401 || res.status === 403 ? ' (check the API key in Settings)' : ''
  throw new Error(`Web search failed: ${res.status}${hint} ${detail.slice(0, 200)}`.trim())
}

/** Shared rendering so every provider's output reads the same to the model. */
function formatHits(hits: SearchHit[], answer?: string): string {
  if (hits.length === 0 && !answer) return 'No results.'
  const lines: string[] = []
  if (answer) lines.push(`Answer: ${answer.trim()}`, '')
  for (const r of hits) {
    lines.push(`- ${r.title ?? '(untitled)'}\n  ${r.url ?? ''}\n  ${(r.content ?? '').trim().slice(0, 300)}`)
  }
  return lines.join('\n').trim()
}

const TAVILY_URL = 'https://api.tavily.com/search'

interface TavilyResponse {
  answer?: string
  results?: Array<{ title?: string; url?: string; content?: string }>
}

export const tavilySearch: SearchFn = async (query, apiKey, opts = {}) => {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(TAVILY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: clampResults(opts.maxResults),
      include_answer: true,
      search_depth: 'basic'
    }),
    signal: opts.signal
  })
  await failIfNotOk(res)
  const data = (await res.json()) as TavilyResponse
  const hits = (data.results ?? []).map((r) => ({ title: r.title, url: r.url, content: r.content }))
  return formatHits(hits, data.answer)
}

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResponse {
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> }
}

export const braveSearch: SearchFn = async (query, apiKey, opts = {}) => {
  const doFetch = opts.fetchImpl ?? fetch
  const url = `${BRAVE_URL}?q=${encodeURIComponent(query)}&count=${clampResults(opts.maxResults)}`
  const res = await doFetch(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'x-subscription-token': apiKey },
    signal: opts.signal
  })
  await failIfNotOk(res)
  const data = (await res.json()) as BraveResponse
  const hits = (data.web?.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.description
  }))
  return formatHits(hits)
}

const EXA_URL = 'https://api.exa.ai/search'

interface ExaResponse {
  results?: Array<{ title?: string; url?: string; text?: string; highlights?: string[] }>
}

export const exaSearch: SearchFn = async (query, apiKey, opts = {}) => {
  const doFetch = opts.fetchImpl ?? fetch
  const res = await doFetch(EXA_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      query,
      numResults: clampResults(opts.maxResults),
      // Ask for short text + the most relevant highlights so each hit carries a
      // usable snippet without dragging back whole pages.
      contents: { text: { maxCharacters: 400 }, highlights: true }
    }),
    signal: opts.signal
  })
  await failIfNotOk(res)
  const data = (await res.json()) as ExaResponse
  const hits = (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    // Highlights are the LLM-picked relevant spans; fall back to the page text.
    content: r.highlights?.join(' ') || r.text
  }))
  return formatHits(hits)
}

const ADAPTERS: Record<string, SearchFn> = {
  tavily: tavilySearch,
  brave: braveSearch,
  exa: exaSearch
}

/** The adapter for a provider id, falling back to Tavily for unknown ids. */
export function getSearchAdapter(id: string): SearchFn {
  return ADAPTERS[id] ?? tavilySearch
}
