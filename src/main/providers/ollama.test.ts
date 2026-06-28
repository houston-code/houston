import { describe, it, expect, vi, afterEach } from 'vitest'
import { ollamaSupportsTools } from './ollama'

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
