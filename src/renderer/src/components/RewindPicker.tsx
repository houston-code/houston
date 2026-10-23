import { useRef, useState, type KeyboardEvent } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import type { RewindTarget } from './RewindDialog'

/**
 * Esc Esc on an empty composer: pick one of your earlier messages to rewind to.
 * Newest first, Up/Down to move, Enter to choose, Esc to close. Choosing one opens
 * the rewind confirmation, where the mode is picked.
 */
export function RewindPicker<T extends RewindTarget>({
  targets,
  onPick,
  onClose
}: {
  /** The user's messages, oldest first (as the transcript numbers them). */
  targets: T[]
  onPick: (target: T) => void
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  const newestFirst = [...targets].reverse()
  const [active, setActive] = useState(0)
  const items = useRef<(HTMLButtonElement | null)[]>([])

  // Focus follows the highlighted message, so the focus ring, Enter, and the
  // highlight always mean the same row (the dialog opens on the newest one).
  const move = (to: number): void => {
    setActive(to)
    items.current[to]?.focus()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (newestFirst.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move((active + 1) % newestFirst.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move((active - 1 + newestFirst.length) % newestFirst.length)
    } else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('.modal__close')) {
      // Enter on the close button closes; anywhere else it picks the highlighted row.
      e.preventDefault()
      onPick(newestFirst[active])
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--sm rewind-picker"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-picker-title"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="rewind-picker-title">Rewind to an earlier message</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal__body">
          {newestFirst.length === 0 ? (
            <p className="rewind-picker__empty">No earlier messages to rewind to yet.</p>
          ) : (
            <ul className="rewind-picker__list" role="listbox" aria-label="Your messages">
              {newestFirst.map((t, i) => (
                <li key={t.turn} role="option" aria-selected={i === active}>
                  <button
                    ref={(el) => {
                      items.current[i] = el
                    }}
                    type="button"
                    {...(i === 0 ? { 'data-autofocus': true } : {})}
                    className={`rewind-picker__item${i === active ? ' rewind-picker__item--active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onClick={() => onPick(t)}
                  >
                    <span className="rewind-picker__num">{t.turn + 1}</span>
                    <span className="rewind-picker__label">{t.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
