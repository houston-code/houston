import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatRequest } from '@shared/agent'
import { createGeminiProvider, listGeminiModels } from './gemini'

/**
 * The Gemini provider talks to the Gemini API with the user's API key, whatever the shell
 * says. Left to itself the real SDK reads GOOGLE_GENAI_USE_VERTEXAI and
 * GOOGLE_GENAI_USE_ENTERPRISE and switches to Vertex AI, which would send the key to
 * another service. These drive the real SDK with a fetch that records where it went.
 */
function recordHosts(): string[] {
  const hosts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
      hosts.push(new URL(url).host)
      return new Response(JSON.stringify({ error: { code: 400, message: 'stub', status: 'INVALID_ARGUMENT' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      })
    })
  )
  return hosts
}

describe('Gemini endpoint with Vertex switches in the environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it.each(['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE'])(
    'a chat request still goes to the Gemini API when %s is set',
    async (name) => {
      vi.stubEnv(name, 'true')
      vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
      const hosts = recordHosts()
      const run = async (): Promise<void> => {
        for await (const _ of createGeminiProvider('k').streamChat({
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'hi' }]
        } as ChatRequest)) {
          // drain
        }
      }
      await expect(run()).rejects.toThrow()
      expect(hosts).toEqual(['generativelanguage.googleapis.com'])
    }
  )

  it('listing models still goes to the Gemini API when GOOGLE_GENAI_USE_VERTEXAI is set', async () => {
    vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true')
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '')
    const hosts = recordHosts()
    await expect(listGeminiModels('k')).rejects.toThrow()
    expect(hosts).toEqual(['generativelanguage.googleapis.com'])
  })
})
