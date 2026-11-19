import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import { providerAcceptsPdf, providerSendsXhigh } from '@shared/model-facts'

/**
 * The built-in OpenAI provider picks its adapter from where requests really go: the
 * Responses API on OpenAI's own host, Chat Completions through a gateway. The loop's
 * PDF and `xhigh` gates must make the same call, or a PDF is attached for a model that
 * never receives it (the Chat Completions adapter has no document part).
 */

const made = vi.hoisted(() => ({ adapter: [] as string[] }))

vi.mock('../agentHost', () => ({
  getKey: () => 'sk-test',
  hasStoredKey: () => true,
  getSecretHeaders: () => ({})
}))
vi.mock('./responses', () => ({
  createResponsesProvider: () => {
    made.adapter.push('responses')
    return { streamChat: async function* () {} }
  }
}))
vi.mock('./openai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./openai')>()),
  createOpenAIProvider: () => {
    made.adapter.push('chat')
    return { streamChat: async function* () {} }
  }
}))

import { createProvider } from './index'
import { openaiUsesGateway } from './env-base-url'

const openai = (baseUrl?: string): ProviderConfig => ({
  id: 'openai',
  kind: 'openai',
  label: 'OpenAI',
  models: [],
  requiresKey: true,
  hasKey: true,
  builtIn: true,
  ...(baseUrl ? { baseUrl } : {})
})

/** The adapter createProvider picked, and whether the loop's gates agree with it. */
function route(baseUrl?: string): { adapter: string; pdf: boolean; xhigh: boolean } {
  made.adapter = []
  createProvider(openai(baseUrl))
  const gateway = openaiUsesGateway(baseUrl)
  return {
    adapter: made.adapter[0],
    pdf: providerAcceptsPdf('openai', 'gpt-5', gateway),
    xhigh: providerSendsXhigh('openai', 'gpt-5', gateway)
  }
}

describe('OpenAI routing and the gates that follow it', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('uses the Responses API with no base URL anywhere', () => {
    vi.stubEnv('OPENAI_BASE_URL', '')
    expect(route()).toEqual({ adapter: 'responses', pdf: true, xhigh: true })
  })

  it('treats a gateway from OPENAI_BASE_URL like a configured one, PDFs and xhigh included', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example.test/v1')
    expect(route()).toEqual({ adapter: 'chat', pdf: false, xhigh: false })
    vi.stubEnv('OPENAI_BASE_URL', '')
    expect(route('https://gateway.example.test/v1')).toEqual({ adapter: 'chat', pdf: false, xhigh: false })
  })

  it("keeps the Responses API when the URL is OpenAI's own host", () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    expect(route()).toEqual({ adapter: 'responses', pdf: true, xhigh: true })
    vi.stubEnv('OPENAI_BASE_URL', '')
    expect(route('https://api.openai.com/v1')).toEqual({ adapter: 'responses', pdf: true, xhigh: true })
  })

  it('counts a configured gateway over an OpenAI URL in the environment, and an unparseable URL as a gateway', () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    expect(route('https://gateway.example.test/v1').adapter).toBe('chat')
    vi.stubEnv('OPENAI_BASE_URL', '')
    expect(openaiUsesGateway('not a url')).toBe(true)
  })
})
