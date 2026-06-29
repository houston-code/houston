import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import type { EditorId, EditorStatus } from '@shared/editors'
import {
  buildSidebarSections,
  dropIndexForY,
  reorderedIds,
  type SidebarSection
} from '../lib/chatGroups'
import { listEditors, fileManagerName } from '../lib/editors'
import { Icon } from './Icon'
import { Popover } from './Popover'
import { MenuExpander } from './MenuExpander'

/**
 * Custom drag payload carried when a chat row is dragged onto a group. A
 * dedicated MIME (rather than bare text/plain) lets drop targets recognise our
 * own chat drags and ignore unrelated drags (e.g. files into the composer).
 */
const CONV_DRAG_MIME = 'application/x-houston-conv-id'

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
  /** Conversation ids with a live agent run — each gets a pulsing "running" dot. */
  runningIds: ReadonlySet<string>
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
  /**
   * Persist a drag-to-reorder. `orderedIds` is the target section's chats in
   * their new top-to-bottom order; `move` is set when the drag also crossed into
   * a different group (or out to ungrouped).
   */
  onReorder: (orderedIds: string[], move?: { id: string; groupId: string | null }) => void
  onCreateGroup: () => Promise<string>
  onRenameGroup: (groupId: string, name: string) => void
  onDeleteGroup: (groupId: string) => void
  onToggleGroupCollapsed: (groupId: string) => void
  /** Collapsed state for the built-in sections ('pinned', 'ungrouped'). */
  collapsedSections: Record<string, boolean>
  /** Toggle a built-in section's collapsed state (not a custom group). */
  onToggleSectionCollapsed: (sectionId: string) => void
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

/**
 * The "Open in" expander inside a chat's ⋯ menu: opens the chat's working directory
 * in a detected editor (VS Code / Cursor / Windsurf / Zed / Xcode) or reveals it in
 * the file manager. Only editors found on this machine are listed. A launch failure
 * keeps the menu open and shows why (the mouse is still over the submenu).
 */
function OpenInSubmenu({
  workspace,
  editors,
  onDone
}: {
  workspace: string
  editors: EditorStatus[] | null
  onDone: () => void
}): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const available = (editors ?? []).filter((e) => e.available)

  const openIn = (id: EditorId): void => {
    setError(null)
    void Promise.resolve(window.api?.openInEditor?.(id, workspace)).then((r) => {
      if (r?.ok) onDone()
      else setError(r?.error ?? 'Could not open the editor.')
    })
  }
  const reveal = (): void => {
    setError(null)
    void Promise.resolve(window.api?.revealInFileManager?.(workspace)).then((r) => {
      if (r?.ok) onDone()
      else setError(r?.error ?? 'Could not reveal the folder.')
    })
  }

  return (
    <MenuExpander label="Open in">
      {editors === null ? (
        <div className="menu__note">Checking…</div>
      ) : (
        <>
          {available.map((e) => (
            <button
              key={e.id}
              className="menu__item"
              onClick={() => openIn(e.id)}
            >
              {e.label}
            </button>
          ))}
          <button className="menu__item" onClick={reveal}>
            Reveal in {fileManagerName()}
          </button>
          {available.length === 0 && <div className="menu__note">No editors detected</div>}
          {error && (
            <div className="menu__note menu__note--error" role="alert">
              {error}
            </div>
          )}
        </>
      )}
    </MenuExpander>
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
  const [dragging, setDragging] = useState(false)
  // Editors are probed lazily the first time this row's menu opens (null = not yet).
  const [editors, setEditors] = useState<EditorStatus[] | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const close = (): void => setMenuOpen(false)
  const toggleMenu = (): void => {
    const next = !menuOpen
    setMenuOpen(next)
    // Probe editors only when the bridge is actually present (it always is in the
    // app; guarding keeps unrelated tests from triggering an async state update).
    if (next && editors === null && typeof window.api?.listEditors === 'function') {
      void listEditors().then(setEditors)
    }
  }

  return (
    <div
      className={`conv ${active ? 'conv--active' : ''} ${dragging ? 'conv--dragging' : ''}`}
      // Renaming swaps in a text input; dragging would hijack its selection.
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(CONV_DRAG_MIME, conv.id)
        e.dataTransfer.setData('text/plain', conv.id)
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => !renaming && props.onSelect(conv.id)}
    >
      {props.runningIds.has(conv.id) && (
        <span className="conv__running" role="img" aria-label="Running" title="Running" />
      )}
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
            <>
              {basename(conv.worktree.repoRoot)}{' '}
              <span className="conv__branch" title={`Worktree on branch ${conv.worktree.branch}`}>
                ⑂ {conv.worktree.branch}
              </span>
            </>
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
            toggleMenu()
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
            <OpenInSubmenu workspace={conv.workspace} editors={editors} onDone={close} />
            <MenuExpander label="Move to group">
              {groups.map((g) => (
                <button
                  key={g.id}
                  className="menu__item"
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
                className="menu__item"
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
                  className="menu__item"
                  onClick={() => {
                    props.onMove(conv.id, null)
                    close()
                  }}
                >
                  <Icon name="removeFromGroup" /> Remove from group
                </button>
              )}
            </MenuExpander>
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
  // Every section header collapses; only custom groups also rename / delete.
  const toggleCollapsed = (): void =>
    isGroup ? props.onToggleGroupCollapsed(section.id) : props.onToggleSectionCollapsed(section.id)

  return (
    <div className={`section-head section-head--${section.kind}`}>
      <button className="section-head__toggle" onClick={toggleCollapsed}>
        <span className="section-head__chevron">{section.collapsed ? '▸' : '▾'}</span>
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

/** Pointer location → drop slot, read from the section's currently rendered rows. */
function dropIndexFromEvent(section: Element, clientY: number): number {
  const rows = Array.from(section.querySelectorAll<HTMLElement>('.conv'))
  return dropIndexForY(
    rows.map((r) => r.getBoundingClientRect()),
    clientY
  )
}

/**
 * One sidebar section (Pinned / a group / Ungrouped) plus its rows. Group and
 * Ungrouped sections double as drop targets for drag-to-reorder: a chat can be
 * dropped at a precise slot to reposition it, and dropping a chat from another
 * section both moves it in and places it. A drop indicator marks where it will
 * land. Pinned is not a drop target — pinning is independent of grouping.
 */
function SidebarSectionView({
  section,
  props,
  currentId,
  renamingConv,
  renamingGroup,
  setRenamingConv,
  setRenamingGroup
}: {
  section: SidebarSection
  props: SidebarProps
  currentId: string | null
  renamingConv: string | null
  renamingGroup: string | null
  setRenamingConv: (id: string | null) => void
  setRenamingGroup: (id: string | null) => void
}): JSX.Element {
  const { groups } = props
  // Slot the drop indicator sits at while dragging over this section, or null.
  const [dropAt, setDropAt] = useState<number | null>(null)

  const droppable = section.kind === 'group' || section.kind === 'ungrouped'
  // Group sections move the chat into the group; Ungrouped clears its group.
  const targetGroupId = section.kind === 'group' ? section.id : null
  const rowCount = section.conversations.length

  const onDragOver = (e: DragEvent): void => {
    if (!e.dataTransfer.types.includes(CONV_DRAG_MIME)) return // not one of our chat drags
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropAt(dropIndexFromEvent(e.currentTarget, e.clientY))
  }
  const onDragLeave = (e: DragEvent): void => {
    // dragleave also fires when crossing into child rows; only clear the
    // indicator once the pointer truly leaves the section.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setDropAt(null)
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDropAt(null)
    const draggedId =
      e.dataTransfer.getData(CONV_DRAG_MIME) || e.dataTransfer.getData('text/plain')
    if (!draggedId) return

    const index = dropIndexFromEvent(e.currentTarget, e.clientY)
    const currentIds = section.conversations.map((c) => c.id)
    const orderedIds = reorderedIds(currentIds, draggedId, index)

    const dragged = props.conversations.find((c) => c.id === draggedId)
    const fromGroup = dragged?.groupId ?? null
    const move = fromGroup !== targetGroupId ? { id: draggedId, groupId: targetGroupId } : undefined

    // Same section, same arrangement → nothing to persist.
    if (!move && orderedIds.length === currentIds.length && orderedIds.every((id, i) => id === currentIds[i]))
      return
    props.onReorder(orderedIds, move)
  }

  return (
    <div
      className="section"
      onDragOver={droppable ? onDragOver : undefined}
      onDragLeave={droppable ? onDragLeave : undefined}
      onDrop={droppable ? onDrop : undefined}
    >
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
        section.conversations.map((c, i) => (
          <Fragment key={c.id}>
            {dropAt === i && <div className="conv-drop-line" aria-hidden="true" />}
            <ConvRow
              conv={c}
              active={c.id === currentId}
              groups={groups}
              props={props}
              renaming={renamingConv === c.id}
              onStartRename={() => setRenamingConv(c.id)}
              onStopRename={() => setRenamingConv(null)}
              onStartRenameGroup={(id) => setRenamingGroup(id)}
            />
          </Fragment>
        ))}
      {!section.collapsed && rowCount > 0 && dropAt === rowCount && (
        <div className="conv-drop-line" aria-hidden="true" />
      )}
      {section.kind === 'group' && !section.collapsed && rowCount === 0 && (
        <div className="section__empty">Drop a chat here, or use the ⋯ menu</div>
      )}
    </div>
  )
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { conversations, groups, currentId } = props
  const sections = buildSidebarSections(conversations, groups, props.collapsedSections)
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
          <SidebarSectionView
            key={section.id}
            section={section}
            props={props}
            currentId={currentId}
            renamingConv={renamingConv}
            renamingGroup={renamingGroup}
            setRenamingConv={setRenamingConv}
            setRenamingGroup={setRenamingGroup}
          />
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
