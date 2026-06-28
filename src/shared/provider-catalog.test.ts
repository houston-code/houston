import { describe, expect, it } from 'vitest'
import {
  PROVIDER_CATALOG,
  catalogEntryToProvider,
  catalogForPlatform
} from './provider-catalog'
import { defaultProviders } from './defaults'

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

  it('every base URL is an absolute http(s) URL ending in a path', () => {
    for (const e of PROVIDER_CATALOG) {
      const url = new URL(e.baseUrl) // throws if not absolute
      expect(url.protocol).toMatch(/^https?:$/)
      expect(url.pathname.length).toBeGreaterThan(1)
    }
  })

  it('cloud hosts require a key over https; local hosts do not', () => {
    for (const e of PROVIDER_CATALOG) {
      if (e.category === 'cloud') {
        expect(e.requiresKey).toBe(true)
        expect(new URL(e.baseUrl).protocol).toBe('https:')
      } else {
        expect(e.requiresKey).toBe(false)
      }
    }
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
})
