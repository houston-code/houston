import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig, ProviderKind } from '@shared/types'

// Each adapter imports its SDK on its first request. createProvider starts that
// import when the provider is made, so it loads while the run assembles its prompt
// instead of after. The SDKs are stood in for by modules that record being loaded.

const h = vi.hoisted(() => ({ loaded: [] as string[], key: 'k' as string | null }))

vi.mock('@anthropic-ai/sdk', () => {
  h.loaded.push('@anthropic-ai/sdk')
  return { default: class {} }
})
vi.mock('openai', () => {
  h.loaded.push('openai')
  return { default: class {} }
})
vi.mock('@google/genai', () => {
  h.loaded.push('@google/genai')
  return { GoogleGenAI: class {} }
})
vi.mock('@anthropic-ai/bedrock-sdk', () => {
  h.loaded.push('@anthropic-ai/bedrock-sdk')
  return { AnthropicBedrock: class {} }
})
vi.mock('@anthropic-ai/vertex-sdk', () => {
  h.loaded.push('@anthropic-ai/vertex-sdk')
  return { AnthropicVertex: class {} }
})
vi.mock('@anthropic-ai/foundry-sdk', () => {
  h.loaded.push('@anthropic-ai/foundry-sdk')
  return { default: class {} }
})
vi.mock('../agentHost', () => ({
  getKey: () => h.key,
  hasStoredKey: () => false,
  getSecretHeaders: () => ({})
}))

const { createProvider } = await import('./index')

function cfg(kind: ProviderKind, over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: kind,
    kind,
    label: kind,
    models: [],
    requiresKey: true,
    hasKey: true,
    builtIn: true,
    region: 'us-east-1',
    endpoint: 'https://example.openai.azure.com',
    resource: 'my-resource',
    ...over
  }
}

/** Every provider kind, and the SDK its adapter imports. */
const SDK_OF: Record<ProviderKind, string> = {
  anthropic: '@anthropic-ai/sdk',
  openai: 'openai',
  'openai-compatible': 'openai',
  gemini: '@google/genai',
  bedrock: '@anthropic-ai/bedrock-sdk',
  vertex: '@anthropic-ai/vertex-sdk',
  'azure-openai': 'openai',
  foundry: '@anthropic-ai/foundry-sdk'
}

describe('createProvider SDK preload', () => {
  it('loads nothing for a provider it refuses to create', async () => {
    h.key = null
    expect(() => createProvider(cfg('anthropic'))).toThrow(/No API key set/)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.loaded).toEqual([])
    h.key = 'k'
  })

  it("starts loading the adapter's SDK when the provider is created, before any request", async () => {
    for (const kind of Object.keys(SDK_OF) as ProviderKind[]) {
      const provider = createProvider(cfg(kind, kind === 'openai-compatible' ? { baseUrl: 'http://localhost:1' } : {}))
      expect(typeof provider.streamChat).toBe('function')
      await vi.waitFor(() => expect(h.loaded).toContain(SDK_OF[kind]))
    }
    // Each SDK once: the adapter's own import later resolves from the module cache.
    expect(new Set(h.loaded).size).toBe(h.loaded.length)
  })
})
