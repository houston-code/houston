import { useEffect, useRef, useState } from 'react'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import { buildSidebarSections, type SidebarSection } from '../lib/chatGroups'
import { Icon } from './Icon'
import { Popover } from './Popover'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** Which chats the sidebar shows: live chats ("active") or archived ones. */
export type ConversationStatusFilter = 'active' | 'archived'

export interface SidebarProps {
  conversations: ConversationMeta[]
  groups: ChatGroup[]
  search: string
  onSearch: (query: string) => void
  currentId: string | null
  /** Whether the sidebar is collapsed to a thin rail. */
  collapsed: boolean
  /** Toggle collapsed ⇄ expanded. */
  onToggleCollapse: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onFork: (id: string) => void
  onExport: (id: string) => void
  onExportHtml: (id: string) => void
  onImport: () => void
  onOpenSettings: () => void
  onRename: (id: string, title: string) => void
  onSetPinned: (id: string, pinned: boolean) => void
  onSetArchived: (id: string, archived: boolean) => void
  /** Current status filter, and a setter for the filter control. */
  statusFilter: ConversationStatusFilter
  onStatusFilterChange: (filter: ConversationStatusFilter) => void
  /** Total counts per status (from the full list), shown beside the filter options. */
  statusCounts: { active: number; archived: number }
  onMove: (id: string, groupId: string | null) => void
  onCreateGroup: () => Promise<string>
  onRenameGroup: (groupId: string, name: string) => void
  onDeleteGroup: (groupId: string) => void
  onToggleGroupCollapsed: (groupId: string) => void
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
  onStopRename,
  onStartRenameGroup
}: {
  conv: ConversationMeta
  active: boolean
  groups: ChatGroup[]
  props: SidebarProps
  renaming: boolean
  onStartRename: () => void
  onStopRename: () => void
  onStartRenameGroup: (id: string) => void
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
        <div className="conv__meta">
          {/* Tag archived chats only when they surface outside the Archived view
              (i.e. in search results), so the active list isn't noisy. */}
          {conv.archived && props.statusFilter === 'active' && (
            <span className="conv__tag" title="Archived">Archived</span>
          )}
          {conv.worktree ? (
            <span className="conv__branch" title={`Worktree on branch ${conv.worktree.branch}`}>
              ⑂ {conv.worktree.branch}
            </span>
          ) : (
            basename(conv.workspace)
          )}
        </div>
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
            <button
              className="menu__item"
              onClick={() => {
                props.onSetArchived(conv.id, !conv.archived)
                close()
              }}
            >
              {conv.archived ? (
                <>
                  <Icon name="unarchive" /> Unarchive
                </>
              ) : (
                <>
                  <Icon name="archive" /> Archive
                </>
              )}
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
                void props.onCreateGroup().then((id) => {
                  props.onMove(conv.id, id)
                  onStartRenameGroup(id)
                })
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
                <Icon name="removeFromGroup" /> Remove from group
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
              <Icon name="export" /> Export
            </button>
            <button
              className="menu__item"
              onClick={() => {
                props.onExportHtml(conv.id)
                close()
              }}
            >
              <Icon name="export" /> Export as HTML
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

/** Funnel button beside the search box that filters the chat list by status. */
function FilterButton({
  filter,
  counts,
  onChange
}: {
  filter: ConversationStatusFilter
  counts: { active: number; archived: number }
  onChange: (filter: ConversationStatusFilter) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  // "active" is the default view; anything else counts as a filter being applied.
  const filtered = filter !== 'active'
  const options: { key: ConversationStatusFilter; label: string; count: number }[] = [
    { key: 'active', label: 'Active', count: counts.active },
    { key: 'archived', label: 'Archived', count: counts.archived }
  ]

  return (
    <div className="conv__menu-wrap">
      <button
        ref={btnRef}
        className={`sidebar__filter ${filtered ? 'sidebar__filter--on' : ''}`}
        title="Filter chats"
        aria-label="Filter chats"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="filter" />
        {filtered && <span className="sidebar__filter-dot" />}
      </button>
      {open && (
        <Popover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel="Filter by status"
        >
          <div className="menu__label">Status</div>
          {options.map((o) => (
            <button
              key={o.key}
              role="menuitemradio"
              aria-checked={filter === o.key}
              className="menu__item"
              onClick={() => {
                onChange(o.key)
                setOpen(false)
              }}
            >
              {filter === o.key ? '● ' : '○ '}
              {o.label}
              <span className="menu__item-count">{o.count}</span>
            </button>
          ))}
        </Popover>
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

  // Collapsed: a thin rail with just the expand toggle and the most-used actions.
  if (props.collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <button
          className="sidebar__rail-btn"
          onClick={props.onToggleCollapse}
          title="Expand sidebar (⌘B)"
          aria-label="Expand sidebar"
        >
          »
        </button>
        <button
          className="sidebar__rail-btn"
          onClick={props.onNew}
          title="New chat"
          aria-label="New chat"
        >
          ＋
        </button>
        <div className="sidebar__rail-spacer" />
        <button
          className="sidebar__rail-btn"
          onClick={props.onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          ⚙︎
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <button
        className="sidebar__collapse"
        onClick={props.onToggleCollapse}
        title="Collapse sidebar (⌘B)"
        aria-label="Collapse sidebar"
      >
        «
      </button>
      <button className="btn btn--accent sidebar__new" onClick={props.onNew}>
        ＋ New chat
      </button>

      <div className="sidebar__searchrow">
        <input
          className="sidebar__search"
          type="search"
          placeholder="Search chats…"
          aria-label="Search conversations"
          value={props.search}
          onChange={(e) => props.onSearch(e.target.value)}
        />
        <FilterButton
          filter={props.statusFilter}
          counts={props.statusCounts}
          onChange={props.onStatusFilterChange}
        />
      </div>

      <div className="sidebar__list">
        {conversations.length === 0 && (
          <div className="sidebar__empty">
            {props.search
              ? 'No matching conversations.'
              : props.statusFilter === 'archived'
                ? 'No archived chats.'
                : 'No conversations yet.'}
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
                  onStartRenameGroup={(id) => setRenamingGroup(id)}
                />
              ))}
            {section.kind === 'group' && !section.collapsed && section.conversations.length === 0 && (
              <div className="section__empty">Drop chats here from the ⋯ menu</div>
            )}
          </div>
        ))}
      </div>

      <div className="sidebar__foot">
        <button className="btn btn--sm sidebar__import" onClick={props.onImport}>
          <Icon name="import" /> Import chat
        </button>
        <button className="btn btn--sm sidebar__settings" onClick={props.onOpenSettings}>
          ⚙︎ Settings
        </button>
      </div>
    </aside>
  )
}
