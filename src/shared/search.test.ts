import { describe, expect, it } from 'vitest'
import { WEB_SEARCH_KEY_ID } from './constants'
import {
  SEARCH_PROVIDERS,
  DEFAULT_SEARCH_PROVIDER_ID,
  getSearchProviderInfo
} from './search'

describe('search provider catalog', () => {
  it('keeps Tavily as the default and reuses the legacy key id for it', () => {
    const tavily = getSearchProviderInfo(DEFAULT_SEARCH_PROVIDER_ID)
    expect(tavily.id).toBe('tavily')
    // Backward compatibility: keys saved before multi-provider support live here.
    expect(tavily.keyId).toBe(WEB_SEARCH_KEY_ID)
    expect(SEARCH_PROVIDERS[0].id).toBe(DEFAULT_SEARCH_PROVIDER_ID)
  })

  it('gives every provider a distinct id and key id', () => {
    const ids = SEARCH_PROVIDERS.map((p) => p.id)
    const keyIds = SEARCH_PROVIDERS.map((p) => p.keyId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keyIds).size).toBe(keyIds.length)
  })

  it('falls back to the default for unset or unknown ids', () => {
    expect(getSearchProviderInfo(undefined).id).toBe(DEFAULT_SEARCH_PROVIDER_ID)
    expect(getSearchProviderInfo('does-not-exist').id).toBe(DEFAULT_SEARCH_PROVIDER_ID)
  })

  it('resolves each seeded provider by id', () => {
    for (const p of SEARCH_PROVIDERS) {
      expect(getSearchProviderInfo(p.id)).toEqual(p)
    }
  })
})
