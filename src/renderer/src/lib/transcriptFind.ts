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
  new (...ranges: Range[]): { add?: (range: Range) => unknown }
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

/**
 * Whether `node` lives inside a COLLAPSED `<details>` and so isn't rendered — its
 * text is in the DOM but invisible and can't be scrolled to. Matches there would be
 * "phantom" hits (counted but unreachable), so they're excluded. Text in the
 * `<summary>` itself stays visible when collapsed, so it's not excluded.
 */
function isInCollapsedDetails(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    if (el.tagName === 'DETAILS' && !(el as HTMLDetailsElement).open) {
      const summary = el.querySelector(':scope > summary')
      return !(summary?.contains(node) ?? false)
    }
    el = el.parentElement
  }
  return false
}

/**
 * Most matches find collects and highlights. A one-letter query in a long chat matches
 * tens of thousands of times: each match is a live Range the browser must keep up to
 * date on every later DOM change, and painting them all costs far more than the count
 * is worth. Past this, the count reads "2000+" and stepping covers the first 2,000.
 */
export const MAX_FIND_MATCHES = 2000

/**
 * All non-overlapping, case-insensitive match ranges of `query` within `root`, in
 * document order, stopping once `limit` have been found.
 */
export function collectMatchRanges(root: HTMLElement, query: string, limit = Infinity): Range[] {
  const ranges: Range[] = []
  const needle = query.toLowerCase()
  if (!needle || limit <= 0) return ranges
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Skip text hidden inside a collapsed <details> so it can't produce a match the
    // user can't see or scroll to (e.g. the plan panel's collapsed file list).
    acceptNode: (n) => (isInCollapsedDetails(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const hay = (node.nodeValue ?? '').toLowerCase()
    let i = hay.indexOf(needle)
    while (i !== -1) {
      const r = document.createRange()
      r.setStart(node, i)
      r.setEnd(node, i + needle.length)
      ranges.push(r)
      if (ranges.length >= limit) return ranges
      i = hay.indexOf(needle, i + needle.length)
    }
  }
  return ranges
}

/** Match ranges of `query` across several roots (e.g. the transcript and the plan panel), concatenated in root order. */
export function collectMatchRangesAcross(roots: HTMLElement[], query: string, limit = Infinity): Range[] {
  const ranges: Range[] = []
  for (const root of roots) {
    if (ranges.length >= limit) break
    ranges.push(...collectMatchRanges(root, query, limit - ranges.length))
  }
  return ranges
}

/**
 * What find shows for `query`: up to {@link MAX_FIND_MATCHES} matches across `roots`,
 * and whether there were more than that.
 */
export function findMatches(roots: HTMLElement[], query: string): { ranges: Range[]; capped: boolean } {
  // One past the cap tells "exactly 2,000" from "more than 2,000".
  const ranges = collectMatchRangesAcross(roots, query, MAX_FIND_MATCHES + 1)
  const capped = ranges.length > MAX_FIND_MATCHES
  if (capped) ranges.length = MAX_FIND_MATCHES
  return { ranges, capped }
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
  // Added one by one rather than spread into the constructor: a spread passes every
  // range as an argument, and enough of them overflow the call stack.
  const all = new Ctor()
  if (typeof all.add === 'function') for (const r of ranges) all.add(r)
  reg.set(ALL, typeof all.add === 'function' ? all : new Ctor(...ranges))
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
