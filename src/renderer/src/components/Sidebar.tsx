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
  onOpenSettings
}: {
  conversations: ConversationMeta[]
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
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
              className="conv__delete"
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

      <button className="btn sidebar__settings" onClick={onOpenSettings}>
        ⚙︎ Settings
      </button>
    </aside>
  )
}
