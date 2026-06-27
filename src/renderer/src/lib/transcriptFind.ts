/**
 * Find-in-conversation backing logic. Matches are highlighted with the CSS Custom
 * Highlight API (`::highlight(...)`) rather than DOM mutation or text selection, so
 * highlighting is independent of focus — it stays visible while the find box has
 * the cursor — and never fights React's ownership of the transcript DOM.
 *
 * `collectMatchRanges` is the pure, testable core; the highlight registry and
 * scrolling are feature-detected so they're a harmless no-op under jsdom.
 */

const ALL = 'houston-find'
const ACTIVE = 'houston-find-active'

interface HighlightCtor {
  new (...ranges: Range[]): unknown
}
interface HighlightRegistry {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

function registry(): HighlightRegistry | null {
  const css = (typeof CSS !== 'undefined' ? CSS : undefined) as
    | { highlights?: HighlightRegistry }
    | undefined
  return css?.highlights ?? null
}

function highlightCtor(): HighlightCtor | null {
  const g = globalThis as { Highlight?: HighlightCtor }
  return typeof g.Highlight === 'function' ? g.Highlight : null
}

/** All non-overlapping, case-insensitive match ranges of `query` within `root`, in document order. */
export function collectMatchRanges(root: HTMLElement, query: string): Range[] {
  const ranges: Range[] = []
  const needle = query.toLowerCase()
  if (!needle) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = (node.nodeValue ?? '').toLowerCase()
    let i = hay.indexOf(needle)
    while (i !== -1) {
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + needle.length)
      ranges.push(r)
      i = hay.indexOf(needle, i + needle.length)
    }
  }
  return ranges
}

/** Paint `ranges` (all matches) plus the one at `activeIndex` (emphasised). No-op without the Highlight API. */
export function setFindHighlights(ranges: Range[], activeIndex: number): void {
  const reg = registry()
  const Ctor = highlightCtor()
  if (!reg || !Ctor) return
  if (ranges.length === 0) {
    reg.delete(ALL)
    reg.delete(ACTIVE)
    return
  }
  reg.set(ALL, new Ctor(...ranges))
  const active = ranges[activeIndex]
  if (active) reg.set(ACTIVE, new Ctor(active))
  else reg.delete(ACTIVE)
}

/** Remove all find highlights. */
export function clearFindHighlights(): void {
  const reg = registry()
  if (!reg) return
  reg.delete(ALL)
  reg.delete(ACTIVE)
}

/** Scroll the element containing a match into view (centred). No-op under jsdom. */
export function scrollRangeIntoView(range: Range | undefined): void {
  range?.startContainer.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}
