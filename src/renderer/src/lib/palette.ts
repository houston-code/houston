/**
 * Command-palette model. The palette is a flat, searchable list of actions and
 * chat-switch targets; App builds the items (each closing over its own handler)
 * and this module owns the (pure, testable) filtering.
 */
import type { ProviderConfig, SelectedModel } from '@shared/types'
import { modelDisplayName, sortedModels } from '@shared/models'

export interface PaletteItem {
  /** Stable id, unique within the list. */
  id: string
  /** Primary label shown in the row. */
  title: string
  /** Group heading the item is listed under (e.g. "Actions", "Switch chat"). */
  section: string
  /** Right-aligned hint, e.g. a key chord or the current value. */
  hint?: string
  /** Extra text folded into the search haystack but not displayed. */
  keywords?: string
  /** Shown dimmed beneath the title (e.g. a chat's folder). */
  subtitle?: string
  /** Invoked when the item is chosen. The palette closes afterwards. */
  run: () => void
}

/**
 * Filter items by a query: case-insensitive, whitespace-split, every token must
 * appear (as a substring) somewhere in the item's title / subtitle / keywords.
 * An empty query returns everything, order preserved.
 */
export function filterPalette(items: PaletteItem[], query: string): PaletteItem[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return items
  return items.filter((it) => {
    const hay = `${it.title} ${it.subtitle ?? ''} ${it.keywords ?? ''} ${it.section}`.toLowerCase()
    return tokens.every((t) => hay.includes(t))
  })
}

/**
 * The palette's "Use <model>" rows: the models of every provider that can be called
 * now (its key is set, or it needs none), in the model picker's order and under its
 * names. A provider still missing its key is left out, as `/model <name>` skips it, so
 * choosing a row never selects a model the composer then can't send to.
 */
export function modelPaletteItems(
  providers: readonly ProviderConfig[],
  selected: SelectedModel | null | undefined,
  onSelect: (sel: SelectedModel) => void
): PaletteItem[] {
  const items: PaletteItem[] = []
  for (const prov of providers) {
    if (prov.requiresKey && !prov.hasKey) continue
    for (const m of sortedModels(prov.kind, prov.models)) {
      const current = selected?.providerId === prov.id && selected?.model === m.id
      items.push({
        id: `model-${prov.id}-${m.id}`,
        title: `Use ${m.label ?? modelDisplayName(prov.kind, m.id)}`,
        subtitle: prov.label,
        section: 'Model',
        keywords: `${m.id} ${prov.id}`,
        hint: current ? '✓ current' : undefined,
        run: () => onSelect({ providerId: prov.id, model: m.id })
      })
    }
  }
  return items
}
