/**
 * Web-search provider catalog, shared by the main process (which runs the search)
 * and the renderer (which renders the Settings picker). Each entry is metadata
 * only — the actual HTTP adapters live in `src/main/agent/websearch.ts`, keyed by
 * the same `id`. The user picks one provider and supplies its key. When no key is
 * set, the keyless {@link MODEL_SEARCH_PROVIDER} takes over on models whose
 * provider runs web search itself (see `src/main/providers/native-search.ts`).
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

/**
 * The keyless provider: the model provider's own server-side web-search tool, run
 * on the active model and billed to the model key the user already set. It has no
 * key of its own, so it isn't offered in the Settings picker: it is used
 * automatically when the selected provider has no key and the active model's
 * provider supports it.
 */
export const MODEL_SEARCH_PROVIDER = {
  id: 'model',
  label: 'Built-in model search',
  needsKey: false
} as const

/** Which search backend web_search uses for one call. */
export type SearchBackend =
  | { kind: 'keyed'; provider: SearchProviderInfo; key: string }
  | { kind: 'model' }
  | { kind: 'none'; provider: SearchProviderInfo }

/**
 * Pick the backend for a search: the selected third-party provider when its key is
 * set (a configured key always wins), else the model provider's own search when the
 * active model offers it, else nothing (the caller explains how to set a key).
 */
export function resolveSearchBackend(opts: {
  selectedId: string | undefined
  getKey: (keyId: string) => string | null | undefined
  modelSearchAvailable: boolean
}): SearchBackend {
  const provider = getSearchProviderInfo(opts.selectedId)
  const key = opts.getKey(provider.keyId)
  if (key) return { kind: 'keyed', provider, key }
  if (opts.modelSearchAvailable) return { kind: 'model' }
  return { kind: 'none', provider }
}
