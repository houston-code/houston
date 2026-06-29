import type { ReactNode } from 'react'

/**
 * A menu row that reveals a nested group of options when highlighted — hovered with
 * the mouse or focused via the keyboard — keeping a long menu compact behind a
 * single line. Expansion is pure CSS (`:hover` / `:focus-within`) so it never
 * flickers, and the nested items only join the tab order while the group is open.
 */
export function MenuExpander({
  label,
  children
}: {
  label: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div className="menu__expander">
      <button type="button" className="menu__item menu__item--expander" aria-haspopup="true">
        <span className="menu__expander-label">{label}</span>
        <span className="menu__expander-caret" aria-hidden="true">
          ▸
        </span>
      </button>
      <div className="menu__submenu" role="group" aria-label={typeof label === 'string' ? label : undefined}>
        {children}
      </div>
    </div>
  )
}
