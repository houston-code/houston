import type { ConversationMeta } from '@shared/agent'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export function Sidebar({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  onExport,
  onImport,
  onOpenSettings
}: {
  conversations: ConversationMeta[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
  onImport: () => void
  onOpenSettings: () => void
}): JSX.Element {
  return (
    <aside className="sidebar">
      <button className="btn btn--accent sidebar__new" onClick={onNew}>
        ＋ New chat
      </button>

      <div className="sidebar__list">
        {conversations.length === 0 && <div className="sidebar__empty">No conversations yet.</div>}
        {conversations.map((c) => (
          <div
            key={c.id}
            className={`conv ${c.id === currentId ? 'conv--active' : ''}`}
            onClick={() => onSelect(c.id)}
          >
            <div className="conv__main">
              <div className="conv__title">{c.title}</div>
              <div className="conv__meta">{basename(c.workspace)}</div>
            </div>
            <button
              className="conv__action"
              title="Export"
              onClick={(e) => {
                e.stopPropagation()
                onExport(c.id)
              }}
            >
              ⤓
            </button>
            <button
              className="conv__action conv__action--danger"
              title="Delete"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(c.id)
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <button className="btn sidebar__import" onClick={onImport}>
        ⤒ Import chat
      </button>
      <button className="btn sidebar__settings" onClick={onOpenSettings}>
        ⚙︎ Settings
      </button>
    </aside>
  )
}
