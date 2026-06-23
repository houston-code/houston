import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import { buildSidebarSections, type SidebarSection } from '../lib/chatGroups'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export interface SidebarProps {
  conversations: ConversationMeta[]
  groups: ChatGroup[]
  search: string
  onSearch: (query: string) => void
  currentId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onFork: (id: string) => void
  onExport: (id: string) => void
  onImport: () => void
  onOpenSettings: () => void
  onRename: (id: string, title: string) => void
  onSetPinned: (id: string, pinned: boolean) => void
  onMove: (id: string, groupId: string | null) => void
  onCreateGroup: () => Promise<string>
  onRenameGroup: (groupId: string, name: string) => void
  onDeleteGroup: (groupId: string) => void
  onToggleGroupCollapsed: (groupId: string) => void
}

/**
 * A dismiss-on-outside-click / Escape menu, portaled to the body and anchored to
 * its trigger with fixed positioning so the sidebar's scroll container can't clip
 * it. Right-aligned to the trigger; flips above when near the viewport bottom.
 */
function Popover({
  anchorRef,
  onClose,
  children
}: {
  anchorRef: RefObject<HTMLElement>
  onClose: () => void
  children: ReactNode
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect()
    if (!a) return
    const openUp = a.bottom > window.innerHeight - 260
    setStyle({
      position: 'fixed',
      right: Math.max(8, window.innerWidth - a.right),
      ...(openUp ? { bottom: window.innerHeight - a.top + 4 } : { top: a.bottom + 4 })
    })
  }, [anchorRef])

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !anchorRef.current?.contains(e.target as Node)
      ) {
        onClose()
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose, anchorRef])

  if (!style) return null
  return createPortal(
    <div className="menu" ref={ref} style={style} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>,
    document.body
  )
}

/** A single-line input used for renaming a chat or a group in place. */
function InlineEdit({
  value,
  onCommit,
  onCancel
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
}): JSX.Element {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = (): void => {
    const t = text.trim()
    if (t) onCommit(t)
    else onCancel()
  }
  return (
    <input
      ref={ref}
      className="inline-edit"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        else if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

function ConvRow({
  conv,
  active,
  groups,
  props,
  renaming,
  onStartRename,
  onStopRename
}: {
  conv: ConversationMeta
  active: boolean
  groups: ChatGroup[]
  props: SidebarProps
  renaming: boolean
  onStartRename: () => void
  onStopRename: () => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const close = (): void => setMenuOpen(false)

  return (
    <div
      className={`conv ${active ? 'conv--active' : ''}`}
      onClick={() => !renaming && props.onSelect(conv.id)}
    >
      {conv.pinned && <span className="conv__pin" title="Pinned">★</span>}
      <div className="conv__main">
        {renaming ? (
          <InlineEdit
            value={conv.title}
            onCommit={(t) => {
              props.onRename(conv.id, t)
              onStopRename()
            }}
            onCancel={onStopRename}
          />
        ) : (
          <div className="conv__title" onDoubleClick={onStartRename}>
            {conv.title}
          </div>
        )}
        <div className="conv__meta">{basename(conv.workspace)}</div>
      </div>

      <div className="conv__menu-wrap">
        <button
          ref={btnRef}
          className="conv__action"
          title="More"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
          }}
        >
          ⋯
        </button>
        {menuOpen && (
          <Popover anchorRef={btnRef} onClose={close}>
            <button
              className="menu__item"
              onClick={() => {
                props.onSetPinned(conv.id, !conv.pinned)
                close()
              }}
            >
              {conv.pinned ? '☆ Unpin' : '★ Pin'}
            </button>
            <button
              className="menu__item"
              onClick={() => {
                onStartRename()
                close()
              }}
            >
              ✎ Rename
            </button>
            <button
              className="menu__item"
              onClick={() => {
                props.onFork(conv.id)
                close()
              }}
            >
              ⑂ Fork
            </button>
            <div className="menu__sep" />
            <div className="menu__label">Move to</div>
            {groups.map((g) => (
              <button
                key={g.id}
                className="menu__item menu__item--indent"
                onClick={() => {
                  props.onMove(conv.id, g.id)
                  close()
                }}
              >
                {conv.groupId === g.id ? '● ' : '○ '}
                {g.name}
              </button>
            ))}
            <button
              className="menu__item menu__item--indent"
              onClick={() => {
                void props.onCreateGroup().then((id) => props.onMove(conv.id, id))
                close()
              }}
            >
              ＋ New group
            </button>
            {conv.groupId && (
              <button
                className="menu__item menu__item--indent"
                onClick={() => {
                  props.onMove(conv.id, null)
                  close()
                }}
              >
                ⤴ Remove from group
              </button>
            )}
            <div className="menu__sep" />
            <button
              className="menu__item"
              onClick={() => {
                props.onExport(conv.id)
                close()
              }}
            >
              ⤓ Export
            </button>
            <button
              className="menu__item menu__item--danger"
              onClick={() => {
                props.onDelete(conv.id)
                close()
              }}
            >
              ✕ Delete
            </button>
          </Popover>
        )}
      </div>
    </div>
  )
}

function GroupHeader({
  section,
  props,
  renaming,
  onStartRename,
  onStopRename
}: {
  section: SidebarSection
  props: SidebarProps
  renaming: boolean
  onStartRename: () => void
  onStopRename: () => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const isGroup = section.kind === 'group'

  return (
    <div className={`section-head section-head--${section.kind}`}>
      <button
        className="section-head__toggle"
        onClick={() => isGroup && props.onToggleGroupCollapsed(section.id)}
        disabled={!isGroup}
      >
        {isGroup && <span className="section-head__chevron">{section.collapsed ? '▸' : '▾'}</span>}
        {renaming ? (
          <InlineEdit
            value={section.name}
            onCommit={(t) => {
              props.onRenameGroup(section.id, t)
              onStopRename()
            }}
            onCancel={onStopRename}
          />
        ) : (
          <span className="section-head__name" onDoubleClick={() => isGroup && onStartRename()}>
            {section.name}
          </span>
        )}
        <span className="section-head__count">{section.conversations.length || ''}</span>
      </button>

      {isGroup && !renaming && (
        <div className="conv__menu-wrap">
          <button
            ref={btnRef}
            className="conv__action"
            title="Group options"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <Popover anchorRef={btnRef} onClose={() => setMenuOpen(false)}>
              <button
                className="menu__item"
                onClick={() => {
                  onStartRename()
                  setMenuOpen(false)
                }}
              >
                ✎ Rename group
              </button>
              <button
                className="menu__item menu__item--danger"
                onClick={() => {
                  props.onDeleteGroup(section.id)
                  setMenuOpen(false)
                }}
              >
                ✕ Delete group
              </button>
            </Popover>
          )}
        </div>
      )}
    </div>
  )
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { conversations, groups, currentId } = props
  const sections = buildSidebarSections(conversations, groups)
  // Which conversation/group is currently being renamed (id), if any.
  const [renamingConv, setRenamingConv] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)

  const onNewGroup = (): void => {
    void props.onCreateGroup().then((id) => setRenamingGroup(id))
  }

  return (
    <aside className="sidebar">
      <button className="btn btn--accent sidebar__new" onClick={props.onNew}>
        ＋ New chat
      </button>

      <input
        className="sidebar__search"
        type="search"
        placeholder="Search chats…"
        aria-label="Search conversations"
        value={props.search}
        onChange={(e) => props.onSearch(e.target.value)}
      />

      <div className="sidebar__list">
        {conversations.length === 0 && (
          <div className="sidebar__empty">
            {props.search ? 'No matching conversations.' : 'No conversations yet.'}
          </div>
        )}

        {sections.map((section) => (
          <div key={section.id} className="section">
            {section.kind === 'ungrouped' && groups.length === 0 ? null : (
              <GroupHeader
                section={section}
                props={props}
                renaming={renamingGroup === section.id}
                onStartRename={() => setRenamingGroup(section.id)}
                onStopRename={() => setRenamingGroup(null)}
              />
            )}
            {!section.collapsed &&
              section.conversations.map((c) => (
                <ConvRow
                  key={c.id}
                  conv={c}
                  active={c.id === currentId}
                  groups={groups}
                  props={props}
                  renaming={renamingConv === c.id}
                  onStartRename={() => setRenamingConv(c.id)}
                  onStopRename={() => setRenamingConv(null)}
                />
              ))}
            {section.kind === 'group' && !section.collapsed && section.conversations.length === 0 && (
              <div className="section__empty">Drop chats here from the ⋯ menu</div>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button className="link sidebar__newgroup" onClick={onNewGroup}>
          ＋ New group
        </button>
        <button className="btn btn--sm sidebar__import" onClick={props.onImport}>
          ⤒ Import chat
        </button>
        <button className="btn btn--sm sidebar__settings" onClick={props.onOpenSettings}>
          ⚙︎ Settings
        </button>
      </div>
    </aside>
  )
}
