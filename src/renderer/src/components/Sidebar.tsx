import { Fragment, useEffect, useRef, useState, type DragEvent } from 'react'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import type { EditorId, EditorStatus } from '@shared/editors'
import {
  signalLabel,
  signalReason,
  statusSignal,
  strongestSignal,
  type ChatSignal,
  type ChatStatusMap
} from '@shared/chatStatus'
import {
  buildSidebarSections,
  descendantsOf,
  dropIndexForY,
  reorderedIds,
  type SidebarSection
} from '../lib/chatGroups'
import { listEditors, fileManagerName } from '../lib/editors'
import { baseName } from '../lib/paths'
import { isMacPlatform } from '../lib/shortcuts'
import { Icon } from './Icon'
import { Popover } from './Popover'
import { MenuExpander } from './MenuExpander'
import { ShareButton } from './ShareButton'

/**
 * Custom drag payload carried when a chat row is dragged onto a group. A
 * dedicated MIME (rather than bare text/plain) lets drop targets recognise our
 * own chat drags and ignore unrelated drags (e.g. files into the composer).
 */
const CONV_DRAG_MIME = 'application/x-houston-conv-id'

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
  /** The toggle's keyboard shortcut as displayed on this platform (e.g. ⌘B, Ctrl+B). */
  toggleShortcut?: string
  /**
   * Status of every conversation with something to show: a live run, the prompts
   * blocking it, or an unread mark. Drives each row's signal dot (needs input,
   * failed, working, unread).
   */
  chatStatus: ChatStatusMap
  /** Mark a chat unread or read by hand. */
  onSetUnread?: (id: string, unread: boolean) => void
  /** Mark every chat read. */
  onMarkAllRead?: () => void
  /** Whether chats wanting attention sort to the top of each section, and its toggle. */
  unreadFirst?: boolean
  onToggleUnreadFirst?: () => void
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
  /** Chats whose spawned sessions are folded away (persisted by the app). */
  collapsedParents?: ReadonlySet<string>
  /** Fold or unfold a chat's spawned sessions. */
  onToggleParentCollapsed?: (id: string) => void
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
            {fileManagerName()}
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

/** The folded parent's tag for its spawned chats' strongest signal, e.g. "2 running". */
function nestedTag(signal: ChatSignal, n: number): string {
  switch (signal) {
    case 'input':
      return `${n} need${n === 1 ? 's' : ''} input`
    case 'error':
      return `${n} failed`
    case 'working':
      return `${n} running`
    case 'unread':
      return `${n} unread`
    case 'idle':
      return ''
  }
}

function ConvRow({
  conv,
  active,
  groups,
  props,
  renaming,
  onStartRename,
  onStopRename,
  onStartRenameGroup,
  depth = 0,
  nested,
  signal,
  reason
}: {
  conv: ConversationMeta
  active: boolean
  groups: ChatGroup[]
  props: SidebarProps
  renaming: boolean
  onStartRename: () => void
  onStopRename: () => void
  onStartRenameGroup: (id: string) => void
  /** 0 for a top-level row; 1+ for a spawned chat nested under its parent. */
  depth?: number
  /**
   * Present when spawned chats nest under this row: their count, the strongest signal
   * among them with how many show it (for the folded tag), and the toggle.
   */
  nested?: {
    count: number
    childSignal: ChatSignal
    childSignalCount: number
    expanded: boolean
    onToggle: () => void
  }
  /** What this row's dot shows (already folded with its children's when collapsed). */
  signal: ChatSignal
  /** Why the chat needs attention, shown at the start of the meta line. */
  reason?: string
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // A chat waiting on the user can't be marked read or unread: answering clears it.
  const isUnread = props.chatStatus[conv.id]?.unread !== undefined
  const canToggleRead = !!props.onSetUnread && (props.chatStatus[conv.id]?.pending.length ?? 0) === 0
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
      className={`conv ${active ? 'conv--active' : ''} ${dragging ? 'conv--dragging' : ''}${depth > 0 ? ' conv--child' : ''}`}
      // Only top-level rows take part in drag-to-reorder (see dropIndexFromEvent);
      // a nested chat goes where its parent goes.
      data-depth={depth}
      data-signal={signal}
      // Keyboard-reachable so a row can be opened without the mouse. Not renaming:
      // the inline input owns focus/keys then. `aria-current` marks the open chat.
      tabIndex={renaming ? -1 : 0}
      aria-current={active ? 'true' : undefined}
      // The row's name carries its state, so a screen reader hears "needs approval"
      // without having to find the dot.
      aria-label={[conv.title, reason ?? signalLabel(signal)].filter(Boolean).join(', ')}
      // Renaming swaps in a text input; dragging would hijack its selection.
      draggable={!renaming && depth === 0}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(CONV_DRAG_MIME, conv.id)
        e.dataTransfer.setData('text/plain', conv.id)
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => !renaming && props.onSelect(conv.id)}
      onKeyDown={(e) => {
        // Only when the row itself is focused — not a nested control (⋯ menu).
        if (!renaming && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          props.onSelect(conv.id)
        }
        // ⌥U / Alt+U toggles read state. Matched on the physical key: on macOS, Option+U
        // is a dead key whose `key` is "¨", not "u".
        if (!renaming && e.target === e.currentTarget && canToggleRead && e.altKey && e.code === 'KeyU') {
          e.preventDefault()
          props.onSetUnread?.(conv.id, !isUnread)
        }
      }}
    >
      {/* Every row reserves the fold arrow's slot at its left edge (empty unless spawned
          chats nest under it), so parents, pinned chats, and plain rows share one dot
          and title edge. */}
      {nested ? (
        <button
          type="button"
          className={`conv__nest-toggle${nested.expanded ? ' conv__nest-toggle--open' : ''}`}
          aria-expanded={nested.expanded}
          aria-label={`${nested.expanded ? 'Hide' : 'Show'} ${nested.count} spawned session${nested.count === 1 ? '' : 's'}`}
          title={`${nested.expanded ? 'Hide' : 'Show'} spawned sessions`}
          onClick={(e) => {
            e.stopPropagation()
            nested.onToggle()
          }}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M6 3.5 10.5 8 6 12.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : (
        <span className="conv__nest-spacer" aria-hidden="true" />
      )}
      {/* The dot's slot is always present so the title never shifts as the signal
          changes; only its look (and accessible name) does. */}
      <span
        className="conv__status"
        data-signal={signal}
        {...(signal !== 'idle'
          ? { role: 'img', 'aria-label': signalLabel(signal), title: signalLabel(signal) }
          : { 'aria-hidden': true })}
      />
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
          {reason && (
            <span className="conv__reason">
              {reason}
              {' · '}
            </span>
          )}
          {nested && !nested.expanded && (
            <span
              className={`conv__tag conv__tag--${nested.childSignal === 'idle' ? 'count' : nested.childSignal}`}
              title={
                nested.childSignal === 'idle'
                  ? 'Spawned sessions under this chat'
                  : `${nested.childSignalCount} of the ${nested.count} spawned sessions under this chat: ${nestedTag(nested.childSignal, nested.childSignalCount)}`
              }
            >
              {nested.childSignal === 'idle'
                ? `${nested.count} spawned`
                : nestedTag(nested.childSignal, nested.childSignalCount)}
            </span>
          )}
          {conv.worktree ? (
            <>
              {baseName(conv.worktree.repoRoot)}{' '}
              <span className="conv__branch" title={`Worktree on branch ${conv.worktree.branch}`}>
                <Icon name="gitBranch" size={11} className="conv__branch-icon" />
                {conv.worktree.branch}
              </span>
            </>
          ) : (
            baseName(conv.workspace)
          )}
        </div>
      </div>

      {/* Pinned sits at the trailing edge, so it never pushes the title right. */}
      {conv.pinned && (
        <span className="conv__pin" role="img" aria-label="Pinned" title="Pinned">
          ★
        </span>
      )}
      <div className="conv__menu-wrap">
        <button
          ref={btnRef}
          className="conv__action"
          title="More"
          aria-label={`More actions for ${conv.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
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
            {canToggleRead && (
              <button
                className="menu__item"
                onClick={() => {
                  props.onSetUnread?.(conv.id, !isUnread)
                  close()
                }}
              >
                {isUnread ? '○ Mark as read' : '● Mark as unread'}
                <kbd className="menu__item-count">{isMacPlatform() ? '⌥U' : 'Alt+U'}</kbd>
              </button>
            )}
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
              <Icon name="gitBranch" /> Fork
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
            aria-label={`Options for group ${section.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
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
  onChange,
  unreadCount,
  onMarkAllRead,
  unreadFirst,
  onToggleUnreadFirst
}: {
  filter: ConversationStatusFilter
  counts: { active: number; archived: number }
  onChange: (filter: ConversationStatusFilter) => void
  /** How many chats are unread (or failed and unseen), for "Mark all as read". */
  unreadCount: number
  onMarkAllRead?: () => void
  unreadFirst: boolean
  onToggleUnreadFirst?: () => void
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
          {(onMarkAllRead || onToggleUnreadFirst) && <div className="menu__sep" />}
          {onMarkAllRead && (
            <button
              role="menuitem"
              className="menu__item"
              disabled={unreadCount === 0}
              onClick={() => {
                onMarkAllRead()
                setOpen(false)
              }}
            >
              Mark all as read
              <span className="menu__item-count">{unreadCount}</span>
            </button>
          )}
          {onToggleUnreadFirst && (
            <button
              role="menuitemcheckbox"
              aria-checked={unreadFirst}
              className="menu__item"
              onClick={() => {
                onToggleUnreadFirst()
                setOpen(false)
              }}
            >
              {unreadFirst ? '☑ ' : '☐ '}
              Show unread first
            </button>
          )}
        </Popover>
      )}
    </div>
  )
}

/** Pointer location → drop slot, read from the section's currently rendered rows. */
function dropIndexFromEvent(section: Element, clientY: number): number {
  // Top-level rows only: nested spawned chats aren't reorderable slots.
  const rows = Array.from(section.querySelectorAll<HTMLElement>('.conv[data-depth="0"]'))
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
  setRenamingGroup,
  collapsedParents,
  toggleParent
}: {
  section: SidebarSection
  props: SidebarProps
  currentId: string | null
  renamingConv: string | null
  renamingGroup: string | null
  setRenamingConv: (id: string | null) => void
  setRenamingGroup: (id: string | null) => void
  /** Parents whose spawned chats the user folded away. */
  collapsedParents: ReadonlySet<string>
  toggleParent: (id: string) => void
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

  // A chat's own signal from its status entry. The open chat never shows failed or
  // unread (the user is looking at it).
  const ownSignal = (c: ConversationMeta): ChatSignal =>
    statusSignal(props.chatStatus[c.id], c.id === currentId)

  // A row plus, unless folded away, the spawned chats nested under it (recursively).
  // A parent holding the open chat stays unfolded, so the open chat is never hidden.
  // Every row reserves the fold arrow's slot, so titles line up at every level.
  const renderTree = (c: ConversationMeta, depth: number): JSX.Element => {
    const kids = section.children[c.id] ?? []
    const all = kids.length ? descendantsOf(c.id, section.children) : []
    const expanded = !collapsedParents.has(c.id) || all.some((d) => d.id === currentId)
    const own = ownSignal(c)
    const childSignals = all.map(ownSignal)
    const childSignal = strongestSignal(childSignals)
    // Folded, the parent's dot stands for its hidden children too; open, they show
    // their own dots, so the parent shows only its own state.
    const signal = expanded ? own : strongestSignal([own, childSignal])
    const reason = signalReason(props.chatStatus[c.id], own)
    return (
      <>
        <ConvRow
          conv={c}
          active={c.id === currentId}
          groups={groups}
          props={props}
          renaming={renamingConv === c.id}
          onStartRename={() => setRenamingConv(c.id)}
          onStopRename={() => setRenamingConv(null)}
          onStartRenameGroup={(id) => setRenamingGroup(id)}
          depth={depth}
          signal={signal}
          {...(reason ? { reason } : {})}
          {...(kids.length
            ? {
                nested: {
                  count: all.length,
                  childSignal,
                  childSignalCount: childSignals.filter((x) => x === childSignal).length,
                  expanded,
                  onToggle: () => toggleParent(c.id)
                }
              }
            : {})}
        />
        {expanded && kids.length > 0 && (
          <div className="conv-children" role="group" aria-label={`Spawned from ${c.title}`}>
            {kids.map((k) => (
              <Fragment key={k.id}>{renderTree(k, depth + 1)}</Fragment>
            ))}
          </div>
        )}
      </>
    )
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
            {renderTree(c, 0)}
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

const NO_PARENTS: ReadonlySet<string> = new Set()

export function Sidebar(props: SidebarProps): JSX.Element {
  const { conversations, groups, currentId } = props
  const shortcut = props.toggleShortcut ? ` (${props.toggleShortcut})` : ''
  // A chat wants attention when it waits on the user or has something unseen.
  const wantsAttention = (id: string): boolean => {
    const st = props.chatStatus[id]
    return !!st && (st.pending.length > 0 || (st.unread !== undefined && id !== currentId))
  }
  const sections = buildSidebarSections(
    conversations,
    groups,
    props.collapsedSections,
    props.unreadFirst ? wantsAttention : undefined
  )
  const unreadCount = Object.values(props.chatStatus).filter((st) => st.unread !== undefined).length
  // Which conversation/group is currently being renamed (id), if any.
  const [renamingConv, setRenamingConv] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  // Parents whose spawned chats are folded away (saved in settings; expanded by default).
  const collapsedParents = props.collapsedParents ?? NO_PARENTS
  const toggleParent = (id: string): void => props.onToggleParentCollapsed?.(id)

  // Collapsed: a thin rail with just the expand toggle and the most-used actions.
  if (props.collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <button
          className="sidebar__rail-btn"
          onClick={props.onToggleCollapse}
          title={`Expand sidebar${shortcut}`}
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
        <ShareButton variant="rail" />
        <button
          className="sidebar__rail-btn"
          onClick={props.onOpenSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Icon name="settings" size={16} />
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <button
        className="sidebar__collapse"
        onClick={props.onToggleCollapse}
        title={`Collapse sidebar${shortcut}`}
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
          unreadCount={unreadCount}
          {...(props.onMarkAllRead ? { onMarkAllRead: props.onMarkAllRead } : {})}
          unreadFirst={props.unreadFirst ?? false}
          {...(props.onToggleUnreadFirst ? { onToggleUnreadFirst: props.onToggleUnreadFirst } : {})}
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
            collapsedParents={collapsedParents}
            toggleParent={toggleParent}
          />
        ))}
      </div>

      <div className="sidebar__foot">
        <ShareButton />
        <button className="btn btn--sm sidebar__import" onClick={props.onImport}>
          <Icon name="import" /> Import chat
        </button>
        <button className="btn btn--sm sidebar__settings" onClick={props.onOpenSettings}>
          <Icon name="settings" /> Settings
        </button>
      </div>
    </aside>
  )
}
