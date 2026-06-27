/**
 * Command-palette model. The palette is a flat, searchable list of actions and
 * chat-switch targets; App builds the items (each closing over its own handler)
 * and this module owns the (pure, testable) filtering.
 */

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
