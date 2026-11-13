import type { RecentFolder } from '../lib/recentFolders'

/**
 * Recent project folders as a row of small buttons, for the welcome screen. A click
 * opens that folder in a new chat; the full path is in each button's tooltip.
 */
export function RecentFolders({
  folders,
  onOpen,
  title = 'Recent folders'
}: {
  folders: readonly RecentFolder[]
  onOpen: (path: string) => void
  title?: string
}): JSX.Element | null {
  if (folders.length === 0) return null
  return (
    <nav className="recent-folders" aria-label={title}>
      <span className="recent-folders__title">{title}:</span>
      <ul className="recent-folders__list">
        {folders.map((f) => (
          <li key={f.path}>
            <button
              type="button"
              className="recent-folders__item"
              title={f.path}
              aria-label={`Open ${f.name} (${f.where})`}
              onClick={() => onOpen(f.path)}
            >
              {f.name}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
