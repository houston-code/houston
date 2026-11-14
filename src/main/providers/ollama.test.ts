import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  isOllamaProvider,
  ollamaContextLength,
  ollamaContextLengthCached,
  ollamaContextNotice,
  ollamaSupportsTools,
  resetOllamaContextCache
} from './ollama'

function mockFetch(impl: (url: string, init: RequestInit) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit) => Promise.resolve(impl(url, init)))
  )
}

const ok = (body: unknown): unknown => ({ ok: true, json: async () => body })

afterEach(() => vi.unstubAllGlobals())

describe('ollamaSupportsTools', () => {
  it('returns true when capabilities include "tools"', async () => {
    let calledUrl = ''
    mockFetch((url) => {
      calledUrl = url
      return ok({ capabilities: ['completion', 'tools'] })
    })
    expect(await ollamaSupportsTools('http://localhost:11434/v1', 'qwen2.5-coder')).toBe(true)
    // Hits the native API at the root, not the /v1 OpenAI-compatible path.
    expect(calledUrl).toBe('http://localhost:11434/api/show')
  })

  it('returns false when capabilities are present but lack "tools"', async () => {
    mockFetch(() => ok({ capabilities: ['completion'] }))
    expect(await ollamaSupportsTools('http://localhost:11434/v1', 'llama2')).toBe(false)
  })

  it('returns null when capabilities are absent (older Ollama)', async () => {
    mockFetch(() => ok({ model_info: {} }))
    expect(await ollamaSupportsTools('http://localhost:11434/v1', 'llama2')).toBeNull()
  })

  it('returns null on a non-ok response (no /api/show, model not pulled)', async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }))
    expect(await ollamaSupportsTools('http://localhost:11434/v1', 'ghost')).toBeNull()
  })

  it('returns null when the server is unreachable or JSON is invalid', async () => {
    mockFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    expect(await ollamaSupportsTools('http://localhost:11434/v1', 'x')).toBeNull()

    mockFetch(() => ({
      ok: true,
      json: async () => {
        throw new Error('not json')
      }
    }))
    expect(await ollamaSupportsTools('http://localhost:11434/v1', 'x')).toBeNull()
  })

  it('tolerates a base URL without a /v1 suffix', async () => {
    let calledUrl = ''
    mockFetch((url) => {
      calledUrl = url
      return ok({ capabilities: ['tools'] })
    })
    expect(await ollamaSupportsTools('http://localhost:11434', 'qwen2.5-coder')).toBe(true)
    expect(calledUrl).toBe('http://localhost:11434/api/show')
  })
})

describe('ollamaContextLength', () => {
  const BASE = 'http://localhost:11434/v1'
  /** Answer /api/show and /api/ps with the given bodies (null: a 404). */
  const server = (show: unknown, ps: unknown): string[] => {
    const urls: string[] = []
    mockFetch((url) => {
      urls.push(url)
      const body = url.endsWith('/api/show') ? show : url.endsWith('/api/ps') ? ps : null
      return body === null ? { ok: false, json: async () => ({}) } : ok(body)
    })
    return urls
  }
  afterEach(() => resetOllamaContextCache())

  it('prefers the context a loaded model is running with', async () => {
    const urls = server(
      { parameters: 'num_ctx 2048', model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960 } },
      { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 4096 }] }
    )
    expect(await ollamaContextLength(BASE, 'qwen3:8b')).toEqual({ contextLength: 4096, trained: 40960 })
    expect(urls).toEqual(['http://localhost:11434/api/show', 'http://localhost:11434/api/ps'])
  })

  it('matches an untagged model name to its :latest entry', async () => {
    server({}, { models: [{ name: 'llama3.3:latest', context_length: 8192 }] })
    expect(await ollamaContextLength(BASE, 'llama3.3')).toEqual({ contextLength: 8192 })
  })

  it("falls back to the Modelfile's num_ctx when the model isn't loaded", async () => {
    server({ parameters: 'stop "<|im_end|>"\nnum_ctx 16384\ntemperature 0.7' }, { models: [] })
    expect(await ollamaContextLength(BASE, 'm')).toEqual({ contextLength: 16384 })
  })

  it('says nothing it cannot know: no loaded model, no num_ctx, or no server', async () => {
    server({ parameters: 'temperature 0.7' }, { models: [] })
    expect(await ollamaContextLength(BASE, 'm')).toBeNull()
    server(null, null)
    expect(await ollamaContextLength(BASE, 'm')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))))
    expect(await ollamaContextLength(BASE, 'm')).toBeNull()
  })

  it('caches a probe for a minute per server and model', async () => {
    const urls = server({ parameters: 'num_ctx 4096' }, { models: [] })
    let now = 0
    await ollamaContextLengthCached(BASE, 'm', undefined, () => now)
    await ollamaContextLengthCached(BASE, 'm', undefined, () => now)
    expect(urls).toHaveLength(2)
    now = 61_000
    await ollamaContextLengthCached(BASE, 'm', undefined, () => now)
    expect(urls).toHaveLength(4)
  })

  it('names the fix in its notice', () => {
    const n = ollamaContextNotice('qwen3:8b', 4096, 11000)
    expect(n).toMatch(/4,096-token context/)
    expect(n).toMatch(/about 11,000/)
    expect(n).toMatch(/OLLAMA_CONTEXT_LENGTH=32768/)
    expect(n).toMatch(/PARAMETER num_ctx 32768/)
  })

  it('recognizes an Ollama provider by its built-in id or port', () => {
    expect(isOllamaProvider({ id: 'ollama', kind: 'openai-compatible' })).toBe(true)
    expect(isOllamaProvider({ id: 'x', kind: 'openai-compatible', baseUrl: 'http://box:11434/v1' })).toBe(true)
    expect(isOllamaProvider({ id: 'x', kind: 'openai-compatible', baseUrl: 'http://localhost:1234/v1' })).toBe(false)
    expect(isOllamaProvider({ id: 'ollama', kind: 'anthropic' })).toBe(false)
  })
})
