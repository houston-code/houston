import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { SettingsCtx } from './context'
import type { SectionEntry } from './pages'
import { SectionFrame } from './SectionFrame'
import { matchesTerms, normalizeForSearch, searchHaystack } from './search'

/**
 * A section rendered for a search: always mounted, so its own text (title,
 * description, labels, hints) can be read back from the DOM and searched without
 * a second copy of that copy to keep in sync, and hidden when the query misses
 * it. Reports whether it matched, so the shell can count results per page.
 */
export function SearchableSection({
  entry,
  pageLabel,
  terms,
  ctx,
  onResult
}: {
  entry: SectionEntry
  pageLabel: string
  terms: string[]
  ctx: SettingsCtx
  onResult: (id: string, matched: boolean) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [domText, setDomText] = useState('')
  // Read the text on mount, then again whenever it changes: it follows the settings
  // (a new MCP server's status line, a provider's label, a fetched version).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => setDomText(normalizeForSearch(el.textContent ?? ''))
    read()
    const observer = new MutationObserver(read)
    observer.observe(el, { subtree: true, childList: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  const values = entry.values
  const haystack = useMemo(
    () => searchHaystack([pageLabel, domText, ...(entry.keywords ?? []), ...(values ? values(ctx.settings) : [])]),
    [pageLabel, domText, entry.keywords, values, ctx.settings]
  )
  // A section that renders nothing (an optional one without its handler) never matches.
  const matched = domText !== '' && matchesTerms(terms, haystack)
  // Before paint, so the result count never flashes "no results" on the way in.
  useLayoutEffect(() => {
    onResult(entry.id, matched)
  }, [entry.id, matched, onResult])

  return (
    <div ref={ref} className="set-result" data-section={entry.id} hidden={!matched}>
      <SectionFrame entry={entry} ctx={ctx} />
    </div>
  )
}
