import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { searchPromptHistory } from '../lib/promptHistory'

/**
 * Ctrl+R in the composer: search the prompts sent before. Typing filters (newest
 * first), the arrows or Ctrl+R again move to an older match, Enter puts the chosen
 * prompt in the message box, and Escape closes without changing it.
 */
export function HistorySearch({
  history,
  onPick,
  onClose,
  onDismiss
}: {
  /** Oldest first, as stored. */
  history: string[]
  onPick: (text: string) => void
  /** Escape (or Enter with nothing matching): close and go back to the message box. */
  onClose: () => void
  /** Focus moved elsewhere: close, leaving focus where it went. */
  onDismiss: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const matches = useMemo(() => searchPromptHistory(history, query), [history, query])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    setIndex(0)
  }, [query])
  useEffect(() => {
    document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [index, listId])

  const move = (by: number): void => {
    if (matches.length === 0) return
    setIndex((i) => (i + by + matches.length) % matches.length)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const chosen = matches[index]
      if (chosen !== undefined) onPick(chosen)
      else onClose()
    } else if (e.key === 'ArrowDown' || (e.key === 'r' && e.ctrlKey)) {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    }
  }

  return (
    <div className="history-search">
      <label className="history-search__field">
        <span className="history-search__label">Search sent messages</span>
        <input
          ref={inputRef}
          className="history-search__input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={onDismiss}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={listId}
          aria-activedescendant={matches.length ? `${listId}-${index}` : undefined}
          placeholder="Type to filter"
          spellCheck={false}
        />
      </label>
      {matches.length > 0 ? (
        <ul className="mention-menu history-search__list" id={listId} role="listbox" aria-label="Sent messages">
          {matches.map((m, i) => (
            <li
              key={`${i}-${m}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              className={`mention-item ${i === index ? 'mention-item--active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                onPick(m)
              }}
            >
              <span className="history-search__text">{m}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="history-search__empty">{history.length ? 'No sent message matches.' : 'Nothing sent yet.'}</p>
      )}
    </div>
  )
}
