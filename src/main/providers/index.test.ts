import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'

/**
 * `createProvider` gates a run on a *usable* key. It must distinguish "no key was
 * ever set" from "a key is stored but can't be decrypted" so the error tells the
 * user whether to enter a key or re-enter the one that silently went stale.
 */

const secrets = vi.hoisted(() => ({
  key: null as string | null,
  stored: false,
  headers: {} as Record<string, string>
}))

vi.mock('../agentHost', () => ({
  getKey: () => secrets.key,
  hasStoredKey: () => secrets.stored,
  getSecretHeaders: () => secrets.headers
}))

import { createProvider, listModels, ProviderError } from './index'

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    models: [],
    requiresKey: true,
    hasKey: false,
    builtIn: true,
    ...overrides
  }
}

describe('createProvider key checks', () => {
  it('throws "No API key set" when nothing is stored', () => {
    secrets.key = null
    secrets.stored = false
    expect(() => createProvider(cfg())).toThrow(ProviderError)
    expect(() => createProvider(cfg())).toThrow('No API key set for Anthropic (Claude).')
  })

  it('throws an unlock-failure message when a key is stored but undecryptable', () => {
    secrets.key = null
    secrets.stored = true
    expect(() => createProvider(cfg())).toThrow(/could not be unlocked/i)
  })

  it('builds a provider when a usable key is present', () => {
    secrets.key = 'sk-test'
    secrets.stored = true
    expect(typeof createProvider(cfg()).streamChat).toBe('function')
  })

  it('does not require a key for local providers', () => {
    secrets.key = null
    secrets.stored = false
    const provider = createProvider(
      cfg({
        id: 'ollama',
        kind: 'openai-compatible',
        label: 'Local — Ollama',
        requiresKey: false,
        baseUrl: 'http://localhost:11434/v1'
      })
    )
    expect(typeof provider.streamChat).toBe('function')
  })
})

/**
 * The cloud-hosted Claude kinds resolve credentials ambiently, so the key gate above
 * must not apply to them — but they do need somewhere to send the request, which is
 * what the region preflight covers.
 */
describe('cloud-hosted Claude kinds', () => {
  const bedrock = (o: Partial<ProviderConfig> = {}): ProviderConfig =>
    cfg({
      id: 'bedrock-aws',
      kind: 'bedrock',
      label: 'Amazon Bedrock (AWS credentials)',
      requiresKey: false,
      region: 'us-east-1',
      ...o
    })
  const vertex = (o: Partial<ProviderConfig> = {}): ProviderConfig =>
    cfg({
      id: 'vertex',
      kind: 'vertex',
      label: 'Google Vertex AI',
      requiresKey: false,
      region: 'us-east5',
      ...o
    })

  beforeEach(() => {
    secrets.key = null
    secrets.stored = false
    delete process.env.AWS_REGION
    delete process.env.AWS_DEFAULT_REGION
    delete process.env.CLOUD_ML_REGION
  })

  it('builds both kinds with no key stored at all', () => {
    expect(typeof createProvider(bedrock()).streamChat).toBe('function')
    expect(typeof createProvider(vertex()).streamChat).toBe('function')
  })

  it('names the setting when no region is configured', () => {
    expect(() => createProvider(bedrock({ region: undefined }))).toThrow(ProviderError)
    expect(() => createProvider(bedrock({ region: undefined }))).toThrow(
      /No region set for Amazon Bedrock \(AWS credentials\)\..*Settings.*AWS_REGION/s
    )
    expect(() => createProvider(vertex({ region: undefined }))).toThrow(/CLOUD_ML_REGION/)
  })

  it('accepts a region from the environment the SDK would read', () => {
    process.env.AWS_DEFAULT_REGION = 'eu-west-1'
    expect(() => createProvider(bedrock({ region: undefined }))).not.toThrow()
    process.env.CLOUD_ML_REGION = 'us-east5'
    expect(() => createProvider(vertex({ region: undefined }))).not.toThrow()
  })

  it('lets an explicit base URL stand in for a Bedrock region, but not a Vertex one', () => {
    // Bedrock derives only its endpoint from the region, so an explicit URL replaces
    // it. Vertex puts the region in the request path too, so it always needs one.
    expect(() =>
      createProvider(bedrock({ region: undefined, baseUrl: 'https://gw.internal/anthropic' }))
    ).not.toThrow()
    expect(() =>
      createProvider(vertex({ region: undefined, baseUrl: 'https://gw.internal/v1' }))
    ).toThrow(/No region set/)
  })

  it('still builds Bedrock when an optional bearer key is stored', () => {
    secrets.key = 'bedrock-key'
    secrets.stored = true
    expect(typeof createProvider(bedrock()).streamChat).toBe('function')
  })
})

/**
 * The Azure-hosted kinds address a resource rather than a region, and unlike their
 * ambient-credential siblings above they do need a stored key — so the key gate
 * applies, and the address preflight is what stands in for the region one.
 */
describe('Azure-hosted kinds', () => {
  const azure = (o: Partial<ProviderConfig> = {}): ProviderConfig =>
    cfg({
      id: 'azure-openai',
      kind: 'azure-openai',
      label: 'Azure OpenAI',
      requiresKey: true,
      endpoint: 'https://my-resource.openai.azure.com',
      ...o
    })
  const foundry = (o: Partial<ProviderConfig> = {}): ProviderConfig =>
    cfg({
      id: 'foundry',
      kind: 'foundry',
      label: 'Microsoft Foundry',
      requiresKey: true,
      resource: 'my-resource',
      ...o
    })

  beforeEach(() => {
    secrets.key = 'azure-key'
    secrets.stored = true
    delete process.env.AZURE_OPENAI_ENDPOINT
    delete process.env.ANTHROPIC_FOUNDRY_RESOURCE
  })

  it('builds both kinds when a key and an address are configured', () => {
    expect(typeof createProvider(azure()).streamChat).toBe('function')
    expect(typeof createProvider(foundry()).streamChat).toBe('function')
  })

  it('names the setting when no address is configured', () => {
    expect(() => createProvider(azure({ endpoint: undefined }))).toThrow(ProviderError)
    expect(() => createProvider(azure({ endpoint: undefined }))).toThrow(
      /No endpoint set for Azure OpenAI\..*Settings.*AZURE_OPENAI_ENDPOINT/s
    )
    expect(() => createProvider(foundry({ resource: undefined }))).toThrow(
      /No resource set for Microsoft Foundry\..*ANTHROPIC_FOUNDRY_RESOURCE/s
    )
  })

  it('accepts an address from the environment the SDK would read', () => {
    process.env.AZURE_OPENAI_ENDPOINT = 'https://env.openai.azure.com'
    expect(() => createProvider(azure({ endpoint: undefined }))).not.toThrow()
    process.env.ANTHROPIC_FOUNDRY_RESOURCE = 'env-resource'
    expect(() => createProvider(foundry({ resource: undefined }))).not.toThrow()
  })

  it('lets an explicit base URL stand in for the address on both', () => {
    // Unlike Vertex, neither puts its resource in the request path — a gateway URL
    // addresses the host completely.
    expect(() =>
      createProvider(azure({ endpoint: undefined, baseUrl: 'https://gw.internal/openai' }))
    ).not.toThrow()
    expect(() =>
      createProvider(foundry({ resource: undefined, baseUrl: 'https://gw.internal/anthropic/' }))
    ).not.toThrow()
  })

  it('still demands a key, which the ambient-credential kinds do not', () => {
    // The whole difference from bedrock-aws/vertex: there is no credential chain to
    // fall back on, so a keyless provider here can only fail at the first turn.
    secrets.key = null
    secrets.stored = false
    expect(() => createProvider(azure())).toThrow(/No API key set for Azure OpenAI/)
    expect(() => createProvider(foundry())).toThrow(/No API key set for Microsoft Foundry/)
  })
})

describe('listModels for hosts with no Models API', () => {
  it('returns curated ids in each host addressing convention', async () => {
    const bedrock = await listModels(
      cfg({ id: 'bedrock-aws', kind: 'bedrock', label: 'Bedrock', requiresKey: false })
    )
    const vertex = await listModels(
      cfg({ id: 'vertex', kind: 'vertex', label: 'Vertex', requiresKey: false })
    )
    const foundry = await listModels(
      cfg({ id: 'foundry', kind: 'foundry', label: 'Foundry', requiresKey: true })
    )
    // Non-empty is the point: the pre-existing `default: return []` arm made an
    // unhandled kind look like a host that simply serves no models.
    expect(bedrock.length).toBeGreaterThan(0)
    expect(vertex.length).toBeGreaterThan(0)
    expect(foundry.length).toBeGreaterThan(0)
    expect(bedrock.every((m) => m.id.startsWith('anthropic.claude-'))).toBe(true)
    expect(vertex.every((m) => m.id.startsWith('claude-'))).toBe(true)
    expect(foundry.every((m) => m.id.startsWith('claude-'))).toBe(true)
  })

  it('echoes the configured deployments for Azure OpenAI', async () => {
    // The one host where the configured list IS the answer: its models are
    // user-named deployments, so there is nothing to fetch and nothing to curate.
    const models = await listModels(
      cfg({
        id: 'azure-openai',
        kind: 'azure-openai',
        label: 'Azure OpenAI',
        requiresKey: true,
        endpoint: 'https://r.openai.azure.com',
        models: [{ id: 'my-gpt5' }, { id: 'my-gpt4o' }]
      })
    )
    expect(models).toEqual([{ id: 'my-gpt5' }, { id: 'my-gpt4o' }])
  })
})
