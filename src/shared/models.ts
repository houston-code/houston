/**
 * Display ordering for a provider's model list. Pure + dependency-light so the
 * renderer and unit tests can share it.
 *
 * The built-in providers' curated default lists (`defaultProviders()`) double as the
 * canonical display order — newest / most capable first. We sort the *stored* list to
 * match that order rather than mutating it, because the stored order drifts: the
 * settings migration appends newly-added defaults (so GPT-5 lands at the bottom of an
 * upgraded install), and a live `Fetch` replaces the list with whatever order the
 * provider's API returns. Models we don't recognize (custom endpoints, fetched ids
 * beyond the curated set) sort after the known ones, in natural order.
 */
import type { ModelOption } from './types'
import { defaultProviders } from './defaults'

/** providerId -> (modelId -> canonical index in the curated defaults). Built once. */
const CANONICAL: Map<string, Map<string, number>> = new Map(
  defaultProviders().map((p) => [p.id, new Map(p.models.map((m, i) => [m.id, i]))])
)

/** Numeric-aware, case-insensitive compare so `gpt-4o` < `gpt-4o mini` and `9` < `10`. */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * A provider's models in display order: curated defaults first (in their defined
 * order), then any unrecognized models in natural order. Stable and non-mutating.
 */
export function sortedModels(providerId: string, models: ModelOption[]): ModelOption[] {
  const canon = CANONICAL.get(providerId)
  return [...models].sort((a, b) => {
    const ia = canon?.get(a.id)
    const ib = canon?.get(b.id)
    if (ia !== undefined && ib !== undefined) return ia - ib
    if (ia !== undefined) return -1
    if (ib !== undefined) return 1
    return naturalCompare(a.label ?? a.id, b.label ?? b.id)
  })
}
