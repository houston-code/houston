import type { AppSettings, SelectedModel } from './types'
import { modelDisplayName } from './models'

/**
 * The fallback chain (`AppSettings.fallbackModels`) as both clients edit it: the
 * desktop's Models page and the terminal's `/model fallback`. Pure, so the two
 * agree on what an entry is called, when it can't serve, and how the list changes.
 */

/** One entry as the editors show it. */
export interface FallbackRow {
  providerId: string
  model: string
  /** `Provider: Model name`, or the raw ids when the provider is gone. */
  label: string
  /** Why a run would skip it, when it would. */
  skipped?: string
}

const same = (a: SelectedModel, b: SelectedModel): boolean => a.providerId === b.providerId && a.model === b.model

/** The chain in order, each entry named and marked when a run would skip it. */
export function fallbackRows(settings: Pick<AppSettings, 'providers' | 'fallbackModels'>): FallbackRow[] {
  return (settings.fallbackModels ?? []).map((f) => {
    const p = settings.providers.find((x) => x.id === f.providerId)
    if (!p) return { ...f, label: `${f.providerId}/${f.model}`, skipped: 'provider removed' }
    const m = p.models.find((x) => x.id === f.model)
    const label = `${p.label ?? p.id}: ${m?.label ?? modelDisplayName(p.kind, f.model)}`
    if (p.requiresKey && !p.hasKey) return { ...f, label, skipped: 'no API key' }
    return { ...f, label }
  })
}

/** The chain with `entry` added at the end, or why it can't be. */
export function addFallback(
  list: readonly SelectedModel[] | undefined,
  entry: SelectedModel
): SelectedModel[] | { error: string } {
  const current = list ?? []
  if (current.some((f) => same(f, entry))) return { error: 'that model is already in the list' }
  return [...current, { providerId: entry.providerId, model: entry.model }]
}

/** The chain without its `index`-th entry (0-based); unchanged when out of range. */
export function removeFallback(list: readonly SelectedModel[] | undefined, index: number): SelectedModel[] {
  return (list ?? []).filter((_, i) => i !== index)
}

/** The chain with entry `index` moved `delta` places (clamped to the ends). */
export function moveFallback(list: readonly SelectedModel[] | undefined, index: number, delta: number): SelectedModel[] {
  const next = [...(list ?? [])]
  if (index < 0 || index >= next.length) return next
  const to = Math.max(0, Math.min(next.length - 1, index + delta))
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item)
  return next
}
