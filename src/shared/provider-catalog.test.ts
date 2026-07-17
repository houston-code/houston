import { describe, expect, it } from 'vitest'
import {
  BEDROCK_MODELS,
  type CatalogEntry,
  PROVIDER_CATALOG,
  VERTEX_MODELS,
  catalogEntryToProvider,
  catalogForPlatform,
  customEndpointError,
  customEndpointToProvider,
  customProviderId
} from './provider-catalog'
import { defaultProviders } from './defaults'
import type { ProviderKind } from './types'

/** An entry's adapter, applying the `openai-compatible` default. */
const entryKind = (e: CatalogEntry): ProviderKind => e.kind ?? 'openai-compatible'
/** Entries reached over an OpenAI-compatible base URL (the bulk of the catalog). */
const urlEntries = PROVIDER_CATALOG.filter((e) => entryKind(e) === 'openai-compatible')
/** Entries with a dedicated adapter that derives its own endpoint (Bedrock, Vertex). */
const nativeEntries = PROVIDER_CATALOG.filter((e) => entryKind(e) !== 'openai-compatible')

describe('PROVIDER_CATALOG', () => {
  it('has unique entry ids', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('never collides with a built-in provider id', () => {
    const builtIn = new Set(defaultProviders().map((p) => p.id))
    for (const e of PROVIDER_CATALOG) {
      expect(builtIn.has(e.id)).toBe(false)
    }
  })

  it('carries a base URL exactly for the openai-compatible entries', () => {
    for (const e of urlEntries) expect(e.baseUrl).toBeDefined()
    // A native kind builds its endpoint from the region; a base URL there would be
    // an override, not a default, so the entry must not ship one.
    for (const e of nativeEntries) expect(e.baseUrl).toBeUndefined()
  })

  it('every base URL is an absolute http(s) URL ending in a path', () => {
    for (const e of urlEntries) {
      const url = new URL(e.baseUrl!) // throws if not absolute
      expect(url.protocol).toMatch(/^https?:$/)
      expect(url.pathname.length).toBeGreaterThan(1)
    }
  })

  it('cloud hosts reached by URL require a key over https; local hosts do not', () => {
    for (const e of urlEntries) {
      if (e.category === 'cloud') {
        expect(e.requiresKey).toBe(true)
        expect(new URL(e.baseUrl!).protocol).toBe('https:')
      } else {
        expect(e.requiresKey).toBe(false)
      }
    }
  })

  it('native cloud kinds are keyless and ship a region plus a curated model list', () => {
    expect(nativeEntries.map((e) => e.id)).toEqual(['bedrock-aws', 'vertex'])
    for (const e of nativeEntries) {
      // Credentials resolve ambiently (an AWS profile, gcloud ADC), so requiring a
      // Houston-stored key would block a correctly configured machine.
      expect(e.requiresKey).toBe(false)
      // The endpoint is derived from the region, so an entry without one can't
      // address a host at all (see `requireRegion` in main/providers/index.ts).
      expect(e.region).toBeTruthy()
      // Neither host has a Models API, so the seeded list is the only model list.
      expect(e.models?.length).toBeGreaterThan(0)
    }
  })

  it('keeps the bearer-token Bedrock preset on its own id and adapter', () => {
    // `bedrock` ships a stored API key for existing users; the native SigV4 path
    // must stay a separate entry or adding it would re-point that key.
    const preset = PROVIDER_CATALOG.find((e) => e.id === 'bedrock')!
    expect(entryKind(preset)).toBe('openai-compatible')
    expect(preset.requiresKey).toBe(true)
    expect(PROVIDER_CATALOG.find((e) => e.id === 'bedrock-aws')!.kind).toBe('bedrock')
  })

  it('addresses Bedrock models with the vendor prefix and Vertex models without', () => {
    // The prefix is Bedrock's addressing, not part of the model name — getting it
    // wrong is a 404 on every turn.
    for (const id of BEDROCK_MODELS) expect(id).toMatch(/^anthropic\.claude-/)
    for (const id of VERTEX_MODELS) expect(id).toMatch(/^claude-/)
  })
})

describe('catalogForPlatform', () => {
  it('hides darwin-only entries off macOS', () => {
    const ids = catalogForPlatform(false).map((e) => e.id)
    expect(ids).not.toContain('omlx')
  })

  it('includes darwin-only entries on macOS', () => {
    const ids = catalogForPlatform(true).map((e) => e.id)
    expect(ids).toContain('omlx')
  })

  it('keeps cross-platform entries on every platform', () => {
    expect(catalogForPlatform(false).map((e) => e.id)).toContain('openrouter')
    expect(catalogForPlatform(true).map((e) => e.id)).toContain('openrouter')
  })
})

describe('catalogEntryToProvider', () => {
  it('produces an addable openai-compatible provider, preserving the stable id', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.id === 'openrouter')!
    expect(catalogEntryToProvider(entry)).toEqual({
      id: 'openrouter',
      kind: 'openai-compatible',
      label: entry.label,
      baseUrl: entry.baseUrl,
      models: [],
      requiresKey: true,
      hasKey: false,
      builtIn: false
    })
  })

  it('carries requiresKey through for local hosts', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.id === 'vllm')!
    expect(catalogEntryToProvider(entry).requiresKey).toBe(false)
  })

  it('produces a keyless, region-bearing provider for a native kind', () => {
    const entry = PROVIDER_CATALOG.find((e) => e.id === 'bedrock-aws')!
    expect(catalogEntryToProvider(entry)).toEqual({
      id: 'bedrock-aws',
      kind: 'bedrock',
      label: entry.label,
      region: 'us-east-1',
      models: BEDROCK_MODELS.map((id) => ({ id })),
      requiresKey: false,
      hasKey: false,
      builtIn: false
    })
  })

  it('omits baseUrl entirely for an entry that has none', () => {
    // Not `baseUrl: undefined` — the config is persisted, and an explicit
    // undefined would survive as a null key in settings.json.
    const p = catalogEntryToProvider(PROVIDER_CATALOG.find((e) => e.id === 'vertex')!)
    expect('baseUrl' in p).toBe(false)
    expect(p.kind).toBe('vertex')
    expect(p.region).toBe('us-east5')
  })
})

describe('customProviderId', () => {
  it('derives a stable custom-<8 hex> id from a UUID', () => {
    expect(customProviderId('abcd1234-ef56-7890-1234-567890abcdef')).toBe('custom-abcd1234')
  })

  it('matches the GUI-legacy shape (first 8 chars of the raw UUID)', () => {
    const uuid = 'aaaabbbb-cccc-dddd-eeee-ffff00001111'
    expect(customProviderId(uuid)).toBe(`custom-${uuid.slice(0, 8)}`)
  })

  it('falls back to custom-endpoint for an empty seed', () => {
    expect(customProviderId('')).toBe('custom-endpoint')
    expect(customProviderId('----')).toBe('custom-endpoint')
  })
})

describe('customEndpointToProvider', () => {
  it('builds a keyless openai-compatible provider with no models', () => {
    const p = customEndpointToProvider('custom-abc', 'My Router', 'https://x/v1')
    expect(p).toEqual({
      id: 'custom-abc',
      kind: 'openai-compatible',
      label: 'My Router',
      baseUrl: 'https://x/v1',
      models: [],
      requiresKey: false,
      hasKey: false,
      builtIn: false
    })
  })
})

describe('customEndpointError', () => {
  it('requires a label and an http(s) URL', () => {
    expect(customEndpointError('', 'https://x/v1')).toMatch(/label/)
    expect(customEndpointError('L', '')).toMatch(/URL/)
    expect(customEndpointError('L', 'ftp://x')).toMatch(/http/)
    expect(customEndpointError('L', 'example.com/v1')).toMatch(/http/) // bare host rejected
    expect(customEndpointError('L', 'https://x/v1')).toBeNull()
    expect(customEndpointError('L', 'http://localhost:8000/v1')).toBeNull()
  })
})
