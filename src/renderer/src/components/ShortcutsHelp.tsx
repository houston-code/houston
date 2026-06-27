import { useMemo, useRef } from 'react'
import { useFocusTrap } from '../lib/useFocusTrap'
import {
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  shortcutDisplays,
  isMacPlatform,
  type ShortcutCategory,
  type ShortcutDef
} from '../lib/shortcuts'

/**
 * A read-only overlay listing every keyboard shortcut, grouped by category and
 * derived straight from the {@link SHORTCUTS} registry — so it can never drift from
 * what the app actually binds. Opened with ⌘/ (or `?`), closed with Esc or the
 * backdrop.
 */
export function ShortcutsHelp({ onClose }: { onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onClose)
  const mac = useMemo(() => isMacPlatform(), [])

  const groups = useMemo(() => {
    const byCat = new Map<ShortcutCategory, ShortcutDef[]>()
    for (const s of SHORTCUTS) {
      const list = byCat.get(s.category) ?? []
      list.push(s)
      byCat.set(s.category, list)
    }
    return SHORTCUT_CATEGORIES.map((cat) => ({ cat, items: byCat.get(cat) ?? [] })).filter(
      (g) => g.items.length > 0
    )
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--sm shortcuts-help"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-help-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="shortcuts-help-title">Keyboard shortcuts</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal__body">
          {groups.map(({ cat, items }) => (
            <section key={cat} className="shortcuts-help__group">
              <h3>{cat}</h3>
              <ul className="shortcuts-help__list">
                {items.map((s) => (
                  <li key={s.id} className="shortcuts-help__row">
                    <span className="shortcuts-help__label">{s.label}</span>
                    <span className="shortcuts-help__keys">
                      {shortcutDisplays(s, mac).map((d, i) => (
                        <span key={i}>
                          {i > 0 && <span className="shortcuts-help__or">or</span>}
                          <kbd className="kbd">{d}</kbd>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
