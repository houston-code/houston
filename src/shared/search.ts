/**
 * Web-search provider catalog, shared by the main process (which runs the search)
 * and the renderer (which renders the Settings picker). Each entry is metadata
 * only — the actual HTTP adapters live in `src/main/agent/websearch.ts`, keyed by
 * the same `id`. The user picks one provider and supplies its key; this is the
 * interim "bring your own key" model until Houston can run a search backend of its
 * own, at which point a hosted provider drops in as one more entry here.
 */

import { WEB_SEARCH_KEY_ID } from './constants'

export interface SearchProviderInfo {
  /** Stable id; matches the adapter key in websearch.ts and `AppSettings.searchProvider`. */
  id: string
  /** Display name for the Settings picker. */
  label: string
  /** Secrets-store id under which this provider's API key is kept. */
  keyId: string
  /** Placeholder shown in the empty key input (hints at the key's shape). */
  keyPlaceholder: string
  /** Where to obtain a key, shown as a hint in Settings. */
  keyUrl: string
}

/**
 * The seeded providers. Tavily stays first (the default) and deliberately reuses
 * the original `WEB_SEARCH_KEY_ID` secret id so keys saved before multi-provider
 * support carry over untouched.
 */
export const SEARCH_PROVIDERS: SearchProviderInfo[] = [
  {
    id: 'tavily',
    label: 'Tavily',
    keyId: WEB_SEARCH_KEY_ID,
    keyPlaceholder: 'tvly-…',
    keyUrl: 'https://app.tavily.com'
  },
  {
    id: 'brave',
    label: 'Brave Search',
    keyId: 'web-search:brave',
    keyPlaceholder: 'BSA…',
    keyUrl: 'https://api-dashboard.search.brave.com'
  },
  {
    id: 'exa',
    label: 'Exa',
    keyId: 'web-search:exa',
    keyPlaceholder: 'exa_…',
    keyUrl: 'https://dashboard.exa.ai/api-keys'
  }
]

/** The provider used when none is selected (and the fallback for unknown ids). */
export const DEFAULT_SEARCH_PROVIDER_ID = 'tavily'

/** Resolve a provider by id, falling back to the default for unset/unknown ids. */
export function getSearchProviderInfo(id: string | undefined): SearchProviderInfo {
  return SEARCH_PROVIDERS.find((p) => p.id === id) ?? SEARCH_PROVIDERS[0]
}
