import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import { filterPalette, type PaletteItem } from '../lib/palette'

/**
 * ⌘K command palette: a single searchable list of actions and chat-switch targets.
 * App builds the items (each closing over its handler); this owns search, keyboard
 * navigation, and selection. Closes on Esc, the backdrop, or after running an item.
 */
export function CommandPalette({
  items,
  initialQuery = '',
  onClose
}: {
  items: PaletteItem[]
  /** Seed the search box (e.g. opening straight onto the model list). */
  initialQuery?: string
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  useFocusTrap(ref, onClose)

  const filtered = useMemo(() => filterPalette(items, query), [items, query])

  // Keep the selection in range as the query narrows the list.
  useEffect(() => {
    setActive((i) => (filtered.length === 0 ? 0 : Math.min(i, filtered.length - 1)))
  }, [filtered])

  // Keep the highlighted row visible while arrowing through a long list. (Optional
  // chaining on scrollIntoView keeps this a no-op under jsdom, which lacks it.)
  useEffect(() => {
    const el = listRef.current?.querySelector('.is-active')
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return
    onClose()
    item.run()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (filtered.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(filtered[active])
    }
  }

  // Render the flat filtered list, inserting a heading whenever the section changes.
  let lastSection: string | null = null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="command-palette"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="command-palette__input"
          type="text"
          placeholder="Type a command or search chats…"
          value={query}
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-list"
          aria-activedescendant={filtered[active] ? `cp-${filtered[active].id}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {filtered.length === 0 ? (
          <div className="command-palette__empty">No matching commands</div>
        ) : (
          <ul className="command-palette__list" id="command-palette-list" role="listbox" ref={listRef}>
            {filtered.map((it, i) => {
              const header = it.section !== lastSection ? it.section : null
              lastSection = it.section
              return (
                <li key={it.id} className="command-palette__group">
                  {header && <div className="command-palette__section">{header}</div>}
                  <div
                    id={`cp-${it.id}`}
                    role="option"
                    aria-selected={i === active}
                    className={`command-palette__row${i === active ? ' is-active' : ''}`}
                    onMouseMove={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      choose(it)
                    }}
                  >
                    <span className="command-palette__title">
                      {it.title}
                      {it.subtitle && <span className="command-palette__subtitle">{it.subtitle}</span>}
                    </span>
                    {it.hint && <span className="command-palette__hint">{it.hint}</span>}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="command-palette__footer">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> navigate
          </span>
          <span>
            <kbd className="kbd">↵</kbd> select
          </span>
          <span>
            <kbd className="kbd">Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  )
}
