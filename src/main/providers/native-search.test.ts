import { describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_WEB_SEARCH_TOOL,
  anthropicWebSearch,
  isFirstPartyAnthropic,
  parseAnthropicSearch,
  parseResponsesSearch,
  responsesWebSearch
} from './native-search'
import { createAnthropicProvider } from './anthropic'
import { createResponsesProvider } from './responses'

// Shapes follow the providers' documented responses: a Messages API reply with a
// server_tool_use, a web_search_tool_result and cited text, and a Responses API
// reply with a web_search_call (sources included) and an annotated message.
const anthropicReply = [
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'widgets 2' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      {
        type: 'web_search_result',
        url: 'https://example.test/notes',
        title: 'Release notes',
        encrypted_content: 'enc',
        page_age: 'May 2, 2026'
      },
      { type: 'web_search_result', url: 'https://example.test/blog', title: 'Blog', encrypted_content: 'enc' }
    ]
  },
  { type: 'text', text: 'Widgets 2 shipped ' },
  {
    type: 'text',
    text: 'in May.',
    citations: [
      {
        type: 'web_search_result_location',
        url: 'https://example.test/notes',
        title: 'Release notes',
        encrypted_index: 'idx',
        cited_text: 'Widgets 2 is generally available as of May 1.'
      }
    ]
  }
]

describe('parseAnthropicSearch', () => {
  it('collects results with their cited text and joins the reply into the answer', () => {
    const r = parseAnthropicSearch(anthropicReply, 5)
    expect(r.answer).toBe('Widgets 2 shipped in May.')
    expect(r.hits).toEqual([
      {
        url: 'https://example.test/notes',
        title: 'Release notes',
        content: '(updated May 2, 2026) Widgets 2 is generally available as of May 1.'
      },
      { url: 'https://example.test/blog', title: 'Blog' }
    ])
  })

  it('caps the hit count', () => {
    expect(parseAnthropicSearch(anthropicReply, 1).hits).toHaveLength(1)
  })

  it('throws on a search-tool error reported inside a successful response', () => {
    const errReply = [
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' }
      }
    ]
    expect(() => parseAnthropicSearch(errReply, 5)).toThrow(/Web search failed: too_many_requests/)
  })

  it('treats an empty result list as no hits, not an error', () => {
    const r = parseAnthropicSearch([{ type: 'web_search_tool_result', tool_use_id: 'x', content: [] }], 5)
    expect(r).toEqual({ hits: [] })
  })

  it('tolerates a malformed reply', () => {
    expect(parseAnthropicSearch(undefined, 5)).toEqual({ hits: [] })
  })
})

describe('anthropicWebSearch', () => {
  it('sends one bounded search on the run model and passes the abort signal', async () => {
    const create = vi.fn(async () => ({ content: anthropicReply }))
    const signal = new AbortController().signal
    const r = await anthropicWebSearch(
      { messages: { create } },
      { model: 'claude-sonnet-5-5', query: 'widgets 2', maxResults: 3, signal }
    )
    expect(r.hits[0].url).toBe('https://example.test/notes')
    const [body, opts] = create.mock.calls[0] as unknown as [Record<string, unknown>, { signal: AbortSignal }]
    expect(body.model).toBe('claude-sonnet-5-5')
    expect(body.tools).toEqual([ANTHROPIC_WEB_SEARCH_TOOL])
    expect(ANTHROPIC_WEB_SEARCH_TOOL).toEqual({ type: 'web_search_20250305', name: 'web_search', max_uses: 1 })
    expect(body.messages).toEqual([{ role: 'user', content: 'Search the web for: widgets 2' }])
    expect(opts.signal).toBe(signal)
  })

  it('returns what the request billed, cache tokens folded into the input total', async () => {
    const create = vi.fn(async () => ({
      content: anthropicReply,
      usage: {
        input_tokens: 12000,
        output_tokens: 300,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
        server_tool_use: { web_search_requests: 1 }
      }
    }))
    const r = await anthropicWebSearch({ messages: { create } }, { model: 'm', query: 'q', maxResults: 3 })
    expect(r.usage).toEqual({
      inputTokens: 12700,
      outputTokens: 300,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
      searches: 1
    })
  })

  it('reports no usage when the reply has none', async () => {
    const create = vi.fn(async () => ({ content: anthropicReply }))
    const r = await anthropicWebSearch({ messages: { create } }, { model: 'm', query: 'q', maxResults: 3 })
    expect(r.usage).toBeUndefined()
    expect(r.hits.length).toBeGreaterThan(0)
  })
})

const responsesReply = [
  {
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
    action: {
      type: 'search',
      query: 'widgets 2',
      sources: [
        { type: 'url', url: 'https://example.test/notes' },
        { type: 'url', url: 'https://example.test/other' },
        { type: 'api', name: 'oai-weather' }
      ]
    }
  },
  {
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text: 'Widgets 2 became generally available on May 1, according to the release notes. (notes)',
        annotations: [
          { type: 'url_citation', url: 'https://example.test/notes', title: 'Release notes', start_index: 0, end_index: 78 },
          { type: 'url_citation', url: 'https://example.test/short', title: 'Short', start_index: 79, end_index: 86 }
        ]
      }
    ]
  }
]

describe('parseResponsesSearch', () => {
  it('lists cited pages first (with real prose spans), then the other sources', () => {
    const r = parseResponsesSearch(responsesReply, 10)
    expect(r.answer).toMatch(/^Widgets 2 became generally available/)
    expect(r.hits).toEqual([
      {
        url: 'https://example.test/notes',
        title: 'Release notes',
        content: 'Widgets 2 became generally available on May 1, according to the release notes.'
      },
      // A link-text-sized span carries nothing useful, so it is dropped.
      { url: 'https://example.test/short', title: 'Short' },
      { url: 'https://example.test/other' }
    ])
  })

  it('caps the hit count and tolerates a malformed reply', () => {
    expect(parseResponsesSearch(responsesReply, 1).hits).toHaveLength(1)
    expect(parseResponsesSearch(null, 5)).toEqual({ hits: [] })
  })
})

describe('responsesWebSearch', () => {
  it('asks for the web_search tool with sources included and nothing stored', async () => {
    const create = vi.fn(async () => ({ output: responsesReply }))
    await responsesWebSearch({ responses: { create } }, { model: 'gpt-5.4', query: 'widgets 2', maxResults: 5 })
    const [body] = create.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(body.model).toBe('gpt-5.4')
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.include).toEqual(['web_search_call.action.sources'])
    expect(body.store).toBe(false)
    expect(body.input).toBe('Search the web for: widgets 2')
  })

  it('returns what the request billed and counts the searches it ran', async () => {
    const create = vi.fn(async () => ({
      output: responsesReply,
      usage: { input_tokens: 9000, output_tokens: 2500, input_tokens_details: { cached_tokens: 1000 } }
    }))
    const r = await responsesWebSearch({ responses: { create } }, { model: 'gpt-5.4', query: 'q', maxResults: 5 })
    expect(r.usage).toEqual({ inputTokens: 9000, outputTokens: 2500, cacheReadTokens: 1000, searches: 1 })
  })

  it('reports no usage when the reply has none, or a malformed one', async () => {
    const none = vi.fn(async () => ({ output: responsesReply }))
    expect((await responsesWebSearch({ responses: { create: none } }, { model: 'g', query: 'q', maxResults: 5 })).usage).toBeUndefined()
    const junk = vi.fn(async () => ({ output: responsesReply, usage: 'nope' }))
    expect((await responsesWebSearch({ responses: { create: junk } }, { model: 'g', query: 'q', maxResults: 5 })).usage).toBeUndefined()
  })
})

describe('which hosts offer built-in search', () => {
  it('recognizes only the first-party Claude API', () => {
    expect(isFirstPartyAnthropic(undefined)).toBe(true)
    expect(isFirstPartyAnthropic('https://api.anthropic.com')).toBe(true)
    expect(isFirstPartyAnthropic('https://gateway.example.test/anthropic')).toBe(false)
    expect(isFirstPartyAnthropic('not a url')).toBe(false)
  })

  it('attaches webSearch to the first-party Claude and OpenAI providers only', () => {
    expect(createAnthropicProvider('k').webSearch).toBeTypeOf('function')
    expect(createAnthropicProvider('k', 'https://api.anthropic.com').webSearch).toBeTypeOf('function')
    expect(createAnthropicProvider('k', 'https://gateway.example.test').webSearch).toBeUndefined()
    expect(createResponsesProvider('k').webSearch).toBeTypeOf('function')
    expect(createResponsesProvider('k', 'https://gateway.example.test/v1').webSearch).toBeUndefined()
  })
})
