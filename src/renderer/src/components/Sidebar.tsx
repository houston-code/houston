import { Fragment, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type RefObject } from 'react'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup, ChatLabel, LabelColor, SidebarGroupBy } from '@shared/types'
import { MAX_LABEL_NAME, cleanLabelName, cycleLabelColor } from '@shared/chatLabels'
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
  autoSectionId,
  childrenShown,
  descendantsOf,
  dropIndexForY,
  reorderedIds,
  sidebarChatOrder,
  sidebarSections,
  type SidebarSection
} from '../lib/chatGroups'
import { listEditors, fileManagerName } from '../lib/editors'
import { baseName } from '../lib/paths'
import { isMacPlatform } from '../lib/shortcuts'
import { listMove, tabStop } from '../lib/rovingFocus'
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
/**
 * The section a dragged chat comes from, and for a chat in a group, the automatic
 * section it would land in once out of it. Carried in the drag's type names, since a
 * drop target can read those (not the data) while the pointer is over it; hex keeps
 * them exact, as the browser lowercases type names.
 */
const DRAG_FROM_MIME = 'application/x-houston-conv-from-'
const DRAG_LANDS_MIME = 'application/x-houston-conv-lands-'
/** Stands for every custom group in {@link DRAG_FROM_MIME}: any group's chat can leave it. */
const FROM_GROUP = 'group'
const hexOf = (s: string): string =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i).toString(16).padStart(4, '0')).join('')

/** Which chats the sidebar shows: live chats ("active") or archived ones. */
export type ConversationStatusFilter = 'active' | 'archived'

export interface SidebarProps {
  conversations: ConversationMeta[]
  groups: ChatGroup[]
  search: string
  onSearch: (query: string) => void
  /** Bumped (Go → Search Chats…) to move focus into the search field. */
  focusSearchSignal?: number
  currentId: string | null
  /** Whether the sidebar is collapsed to a thin rail. */
  collapsed: boolean
  /** Toggle collapsed ⇄ expanded. */
  onToggleCollapse: () => void
  /** The toggle's keyboard shortcut as displayed on this platform (e.g. ⌘B, Ctrl+B). */
  toggleShortcut?: string
  /** The New chat shortcut as displayed on this platform (e.g. ⌘N), for its tooltip. */
  newChatShortcut?: string
  /** The Settings shortcut as displayed on this platform (e.g. ⌘,), for its tooltip. */
  settingsShortcut?: string
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
  /** Automatic sections for the chats outside any group, and its setter. */
  groupBy?: SidebarGroupBy
  onSetGroupBy?: (by: SidebarGroupBy | undefined) => void
  /** The current time, for the date sections. Injectable for tests. */
  now?: number
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onFork: (id: string) => void
  /** Open the chat in a new window (desktop app only). */
  onOpenInNewWindow?: (id: string) => void
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
  /** The user's chat labels, in display order. */
  labels?: ChatLabel[]
  /** Each section's label filter (label ids), by section id. */
  labelFilters?: Record<string, string[]>
  /** Set a section's label filter; an empty list clears it. */
  onSetSectionLabelFilter?: (sectionId: string, labelIds: string[]) => void
  /** Replace a chat's labels with `labelIds`. */
  onSetChatLabels?: (id: string, labelIds: string[]) => void
  /** Create a label named `name`; resolves to its id. */
  onCreateLabel?: (name: string) => Promise<string>
  onUpdateLabel?: (id: string, patch: { name?: string; color?: LabelColor }) => void
  /** Delete a label, taking it off every chat. */
  onDeleteLabel?: (id: string) => void
}

const NO_LABELS: ChatLabel[] = []

/** The known labels among `ids`, in the order the user arranged their labels. */
function labelsIn(ids: readonly string[], labels: readonly ChatLabel[]): ChatLabel[] {
  const want = new Set(ids)
  return labels.filter((l) => want.has(l.id))
}

/** A label's color swatch. */
function LabelDot({ color }: { color: LabelColor }): JSX.Element {
  return <span className="label-dot" data-color={color} aria-hidden="true" />
}

/** How many label chips a row shows before folding the rest into "+N". */
const MAX_ROW_CHIPS = 2

/** A chat's label chips: the first few by name, then a "+N" for the rest. */
function LabelChips({ carried }: { carried: ChatLabel[] }): JSX.Element | null {
  if (carried.length === 0) return null
  const shown = carried.slice(0, MAX_ROW_CHIPS)
  const rest = carried.slice(MAX_ROW_CHIPS)
  return (
    <span className="conv__labels">
      {shown.map((l) => (
        <span key={l.id} className="label-chip" data-color={l.color} title={l.name}>
          {l.name}
        </span>
      ))}
      {rest.length > 0 && (
        <span className="label-chip label-chip--more" title={rest.map((l) => l.name).join(', ')}>
          +{rest.length}
        </span>
      )}
    </span>
  )
}

/** The "Labels" submenu in a chat's ⋯ menu: tick labels on and off, or make a new one. */
function LabelsMenu({
  conv,
  props,
  onDone
}: {
  conv: ConversationMeta
  props: SidebarProps
  onDone: () => void
}): JSX.Element {
  const labels = props.labels ?? NO_LABELS
  const [naming, setNaming] = useState(false)
  const carried = conv.labels ?? []
  const toggle = (id: string): void =>
    props.onSetChatLabels?.(conv.id, carried.includes(id) ? carried.filter((x) => x !== id) : [...carried, id])
  return (
    <>
      {labels.map((l) => {
        const on = carried.includes(l.id)
        return (
          // Stays open on click, so several labels can be ticked in one go.
          <button
            key={l.id}
            role="menuitemcheckbox"
            aria-checked={on}
            className="menu__item"
            onClick={() => toggle(l.id)}
          >
            {on ? <Icon name="check" /> : <span className="menu__icon-slot" />} <LabelDot color={l.color} /> {l.name}
          </button>
        )
      })}
      {labels.length === 0 && <div className="menu__note">No labels yet</div>}
      {naming ? (
        <div className="menu__inline-edit">
          <InlineEdit
            value=""
            placeholder="Label name"
            ariaLabel="New label name"
            maxLength={MAX_LABEL_NAME}
            onCommit={(name) => {
              const clean = cleanLabelName(name)
              setNaming(false)
              if (!clean || !props.onCreateLabel) return
              void props.onCreateLabel(clean).then((id) => props.onSetChatLabels?.(conv.id, [...carried, id]))
              onDone()
            }}
            onCancel={() => setNaming(false)}
          />
        </div>
      ) : (
        props.onCreateLabel && (
          <button role="menuitem" className="menu__item" onClick={() => setNaming(true)}>
            <Icon name="plus" /> New label
          </button>
        )
      )}
    </>
  )
}

/** One label in the label manager: its color (click for the next one), name, and delete. */
function LabelEditorRow({
  label,
  autoFocus,
  onUpdate,
  onDelete
}: {
  label: ChatLabel
  autoFocus: boolean
  onUpdate: (id: string, patch: { name?: string; color?: LabelColor }) => void
  onDelete: (id: string) => void
}): JSX.Element {
  const [name, setName] = useState(label.name)
  useEffect(() => setName(label.name), [label.name])
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!autoFocus) return
    ref.current?.focus()
    ref.current?.select()
  }, [autoFocus])
  const commit = (): void => {
    const clean = cleanLabelName(name)
    if (!clean) {
      setName(label.name)
      return
    }
    if (clean !== label.name) onUpdate(label.id, { name: clean })
  }
  return (
    <div className="label-edit">
      <button
        type="button"
        className="label-edit__color"
        title="Change color"
        aria-label={`Color of ${label.name}: ${label.color}. Change color`}
        onClick={() => onUpdate(label.id, { color: cycleLabelColor(label.color) })}
      >
        <LabelDot color={label.color} />
      </button>
      <input
        ref={ref}
        className="label-edit__name"
        value={name}
        maxLength={MAX_LABEL_NAME}
        aria-label={`Name of label ${label.name}`}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          }
        }}
      />
      <button
        type="button"
        className="label-edit__delete"
        title="Delete label"
        aria-label={`Delete label ${label.name}`}
        onClick={() => onDelete(label.id)}
      >
        <Icon name="trash" />
      </button>
    </div>
  )
}

/** Rename, recolor, delete, and add labels. Opened from the filter menu. */
function LabelManager({
  anchorRef,
  onClose,
  labels,
  onCreate,
  onUpdate,
  onDelete
}: {
  anchorRef: RefObject<HTMLElement | null>
  onClose: () => void
  labels: ChatLabel[]
  onCreate: (name: string) => Promise<string>
  onUpdate: (id: string, patch: { name?: string; color?: LabelColor }) => void
  onDelete: (id: string) => void
}): JSX.Element {
  // The label just made, so its name field takes focus to be typed over.
  const [fresh, setFresh] = useState<string | null>(null)
  return (
    <Popover
      anchorRef={anchorRef}
      onClose={onClose}
      role="dialog"
      ariaLabel="Manage labels"
      // Wider than the filter button's left side of the sidebar, so it opens rightward
      // (over the main pane) instead of running off the window's left edge.
      align="left"
      className="menu label-manager"
      roving={false}
    >
      <div className="menu__label">Labels</div>
      {labels.length === 0 && (
        <div className="menu__note">No labels yet. Add one here or from a chat's ⋯ menu.</div>
      )}
      {labels.map((l) => (
        <LabelEditorRow key={l.id} label={l} autoFocus={fresh === l.id} onUpdate={onUpdate} onDelete={onDelete} />
      ))}
      <button className="menu__item" onClick={() => void onCreate('New label').then(setFresh)}>
        <Icon name="plus" /> New label
      </button>
    </Popover>
  )
}

/** The tag button on a section header: filter the section to chats with any of the ticked labels. */
function SectionLabelFilter({ section, props }: { section: SidebarSection; props: SidebarProps }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const labels = props.labels ?? NO_LABELS
  // Offer the labels the section's chats carry, plus any the filter still names.
  const offered = labelsIn([...section.labelIds, ...section.labelFilter], labels)
  if (!props.onSetSectionLabelFilter || props.search || offered.length === 0) return null
  const active = section.labelFilter
  const set = (ids: string[]): void => props.onSetSectionLabelFilter?.(section.id, ids)
  return (
    <div className="conv__menu-wrap">
      <button
        ref={btnRef}
        className={`section-head__labels${active.length ? ' section-head__labels--on' : ''}`}
        title="Filter by label"
        aria-label={`Filter ${section.name} by label${active.length ? `, ${active.length} selected` : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="tag" size={12} />
        {active.length > 0 && <span className="section-head__labels-count">{active.length}</span>}
      </button>
      {open && (
        <Popover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          role="menu"
          ariaLabel={`Filter ${section.name} by label`}
        >
          <div className="menu__label">Show chats labeled</div>
          {offered.map((l) => {
            const on = active.includes(l.id)
            return (
              <button
                key={l.id}
                role="menuitemcheckbox"
                aria-checked={on}
                className="menu__item"
                onClick={() => set(on ? active.filter((x) => x !== l.id) : [...active, l.id])}
              >
                {on ? <Icon name="check" /> : <span className="menu__icon-slot" />} <LabelDot color={l.color} /> {l.name}
              </button>
            )
          })}
          {active.length > 0 && (
            <>
              <div className="menu__sep" />
              <button
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  set([])
                  setOpen(false)
                }}
              >
                <Icon name="close" /> Clear filter
              </button>
            </>
          )}
        </Popover>
      )}
    </div>
  )
}

/** A single-line input used for renaming a chat or a group in place. */
function InlineEdit({
  value,
  onCommit,
  onCancel,
  placeholder,
  ariaLabel,
  maxLength
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
  placeholder?: string
  ariaLabel?: string
  maxLength?: number
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
      placeholder={placeholder}
      aria-label={ariaLabel}
      maxLength={maxLength}
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
    <MenuExpander label="Open in" icon="external">
      {editors === null ? (
        <div className="menu__note">Checking…</div>
      ) : (
        <>
          {available.map((e) => (
            <button key={e.id} role="menuitem" className="menu__item" onClick={() => openIn(e.id)}>
              {e.label}
            </button>
          ))}
          <button role="menuitem" className="menu__item" onClick={reveal}>
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

/**
 * The folded parent's tag tooltip: "1 of 3 spawned sessions under this chat is
 * running", "All 2 spawned sessions under this chat need input".
 */
function nestedTitle(signal: ChatSignal, n: number, total: number): string {
  const one = n === 1
  const verb =
    signal === 'input'
      ? one
        ? 'needs input'
        : 'need input'
      : signal === 'error'
        ? 'failed'
        : signal === 'working'
          ? one
            ? 'is running'
            : 'are running'
          : one
            ? 'is unread'
            : 'are unread'
  const who =
    total === 1
      ? 'The spawned session under this chat'
      : n === total
        ? `All ${total} spawned sessions under this chat`
        : `${n} of ${total} spawned sessions under this chat`
  return `${who} ${verb}`
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
  reason,
  tabStop: isTabStop = true,
  onFocusRow,
  dragTypes
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
  /** This row is the list's one Tab stop; the arrow keys reach the others. */
  tabStop?: boolean
  onFocusRow?: (id: string) => void
  /** The extra drag types naming where the row is dragged from (see DRAG_FROM_MIME). */
  dragTypes?: () => string[]
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const carried = labelsIn(conv.labels ?? [], props.labels ?? NO_LABELS)
  // The open chat shows no unread dot (it's being looked at), so its toggle offers
  // Mark as unread, matching what the row shows.
  const isUnread = props.chatStatus[conv.id]?.unread !== undefined && !active
  // A chat waiting on the user can't be marked read or unread: answering clears it.
  const canToggleRead = !!props.onSetUnread && (props.chatStatus[conv.id]?.pending.length ?? 0) === 0
  // Editors are probed lazily the first time this row's menu opens (null = not yet).
  const [editors, setEditors] = useState<EditorStatus[] | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const mainBtnRef = useRef<HTMLButtonElement>(null)
  // Where a right-click opened the menu; unset opens it under the ⋯ button.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | undefined>(undefined)
  const close = (): void => {
    setMenuOpen(false)
    setMenuAt(undefined)
  }
  // The ⋯ button is no Tab stop of its own, so when its menu closes (and hands focus
  // back to it) focus moves on to the row's button, where the keyboard user was.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current && !menuOpen && document.activeElement === btnRef.current) mainBtnRef.current?.focus()
    wasOpen.current = menuOpen
  }, [menuOpen])
  const openMenu = (at?: { x: number; y: number }): void => {
    setMenuAt(at)
    setMenuOpen(true)
    // Probe editors only when the bridge is actually present (it always is in the
    // app; guarding keeps unrelated tests from triggering an async state update).
    if (editors === null && typeof window.api?.listEditors === 'function') {
      void listEditors().then(setEditors)
    }
  }
  const toggleMenu = (): void => {
    if (menuOpen) close()
    else openMenu()
  }
  // Tag archived chats only when they surface outside the Archived view (i.e. in
  // search results), so the active list isn't noisy.
  const archivedTag = !!conv.archived && props.statusFilter === 'active'
  const folder = conv.worktree ? baseName(conv.worktree.repoRoot) : baseName(conv.workspace)

  const meta = (
    <span className="conv__meta">
      {archivedTag && (
        <span className="conv__tag" title="Archived">
          Archived
        </span>
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
              : nestedTitle(nested.childSignal, nested.childSignalCount, nested.count)
          }
        >
          {nested.childSignal === 'idle'
            ? `${nested.count} spawned`
            : nestedTag(nested.childSignal, nested.childSignalCount)}
        </span>
      )}
      {conv.worktree ? (
        <>
          {folder}{' '}
          <span className="conv__branch" title={`Worktree on branch ${conv.worktree.branch}`}>
            <Icon name="gitBranch" size={11} className="conv__branch-icon" />
            {conv.worktree.branch}
          </span>
        </>
      ) : (
        folder
      )}
    </span>
  )

  return (
    <div
      className={`conv ${active ? 'conv--active' : ''} ${dragging ? 'conv--dragging' : ''}${depth > 0 ? ' conv--child' : ''}`}
      // Only top-level rows take part in drag-to-reorder (see dropIndexFromEvent);
      // a nested chat goes where its parent goes.
      data-depth={depth}
      data-signal={signal}
      // Renaming swaps in a text input; dragging would hijack its selection.
      draggable={!renaming && depth === 0}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(CONV_DRAG_MIME, conv.id)
        e.dataTransfer.setData('text/plain', conv.id)
        for (const type of dragTypes?.() ?? []) e.dataTransfer.setData(type, conv.id)
        setDragging(true)
      }}
      onDragEnd={() => setDragging(false)}
      onClick={() => !renaming && props.onSelect(conv.id)}
      // Right-click opens the row's ⋯ menu at the pointer. From the keyboard (the
      // context-menu key or Shift+F10) there is no pointer, so it opens under ⋯.
      onContextMenu={(e) => {
        if (renaming) return
        e.preventDefault()
        e.stopPropagation()
        openMenu(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)
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
      {renaming ? (
        <div className="conv__main">
          <InlineEdit
            value={conv.title}
            onCommit={(t) => {
              props.onRename(conv.id, t)
              onStopRename()
            }}
            onCancel={onStopRename}
          />
          {meta}
        </div>
      ) : (
        // The row's button opens the chat (a click anywhere on the row does too). Its
        // name says everything the row shows, so a screen reader hears "needs approval",
        // "Pinned", the folder and the branch without hunting for the dot or the star.
        // `aria-current` marks the open chat. The list is one Tab stop (see Sidebar):
        // only that row's button takes Tab; the arrow keys reach the others.
        <button
          ref={mainBtnRef}
          type="button"
          className="conv__main"
          tabIndex={isTabStop ? 0 : -1}
          data-conv-id={conv.id}
          onFocus={() => onFocusRow?.(conv.id)}
          aria-current={active ? 'true' : undefined}
          aria-label={[
            conv.title,
            carried.length ? `labels: ${carried.map((l) => l.name).join(', ')}` : undefined,
            reason ?? signalLabel(signal),
            archivedTag ? 'Archived' : undefined,
            conv.pinned ? 'Pinned' : undefined,
            folder,
            conv.worktree ? `branch ${conv.worktree.branch}` : undefined
          ]
            .filter(Boolean)
            .join(', ')}
          onKeyDown={(e) => {
            // ⌥U / Alt+U toggles read state. Matched on the physical key: on macOS,
            // Option+U is a dead key whose `key` is "¨", not "u".
            if (canToggleRead && e.altKey && e.code === 'KeyU') {
              e.preventDefault()
              props.onSetUnread?.(conv.id, !isUnread)
            }
          }}
        >
          <span className="conv__title-row">
            <span className="conv__title" title={conv.title} onDoubleClick={onStartRename}>
              {conv.title}
            </span>
            <LabelChips carried={carried} />
          </span>
          {meta}
        </button>
      )}

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
          // Not a Tab stop: the row's button is. From the keyboard the menu opens with
          // Shift+F10 or the context-menu key on the row.
          tabIndex={-1}
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
          <Popover
            anchorRef={btnRef}
            onClose={close}
            role="menu"
            ariaLabel={`Actions for ${conv.title}`}
            at={menuAt}
          >
            <button
              role="menuitem"
              className="menu__item"
              onClick={() => {
                props.onSetPinned(conv.id, !conv.pinned)
                close()
              }}
            >
              <Icon name="star" /> {conv.pinned ? 'Unpin' : 'Pin'}
            </button>
            {canToggleRead && (
              <button
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  props.onSetUnread?.(conv.id, !isUnread)
                  close()
                }}
              >
                <Icon name={isUnread ? 'check' : 'mail'} /> {isUnread ? 'Mark as read' : 'Mark as unread'}
                <kbd className="menu__item-count">{isMacPlatform() ? '⌥U' : 'Alt+U'}</kbd>
              </button>
            )}
            <button
              role="menuitem"
              className="menu__item"
              onClick={() => {
                onStartRename()
                close()
              }}
            >
              <Icon name="pencil" /> Rename
            </button>
            <button
              role="menuitem"
              className="menu__item"
              onClick={() => {
                props.onFork(conv.id)
                close()
              }}
            >
              <Icon name="gitBranch" /> Fork
            </button>
            {props.onOpenInNewWindow && (
              <button
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  props.onOpenInNewWindow?.(conv.id)
                  close()
                }}
              >
                <Icon name="external" /> Open in New Window
              </button>
            )}
            <button
              role="menuitem"
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
            <MenuExpander label="Move to group" icon="folder">
              {groups.map((g) => (
                <button
                  key={g.id}
                  role="menuitemradio"
                  aria-checked={conv.groupId === g.id}
                  className="menu__item"
                  onClick={() => {
                    props.onMove(conv.id, g.id)
                    close()
                  }}
                >
                  {conv.groupId === g.id ? <Icon name="check" /> : <span className="menu__icon-slot" />} {g.name}
                </button>
              ))}
              <button
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  void props.onCreateGroup().then((id) => {
                    props.onMove(conv.id, id)
                    onStartRenameGroup(id)
                  })
                  close()
                }}
              >
                <Icon name="plus" /> New group
              </button>
              {conv.groupId && (
                <button
                  role="menuitem"
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
            {props.onSetChatLabels && (
              <MenuExpander label="Labels" icon="tag">
                <LabelsMenu conv={conv} props={props} onDone={close} />
              </MenuExpander>
            )}
            <div className="menu__sep" />
            <button
              role="menuitem"
              className="menu__item"
              onClick={() => {
                props.onExport(conv.id)
                close()
              }}
            >
              <Icon name="export" /> Export
            </button>
            <button
              role="menuitem"
              className="menu__item"
              onClick={() => {
                props.onExportHtml(conv.id)
                close()
              }}
            >
              <Icon name="export" /> Export as HTML
            </button>
            <button
              role="menuitem"
              className="menu__item menu__item--danger"
              onClick={() => {
                props.onDelete(conv.id)
                close()
              }}
            >
              <Icon name="trash" /> Delete
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
  onStopRename,
  attention,
  searching
}: {
  section: SidebarSection
  props: SidebarProps
  renaming: boolean
  onStartRename: () => void
  onStopRename: () => void
  /** For a collapsed section: the strongest state among its chats that wants the user, and how many show it. */
  attention?: { signal: ChatSignal; count: number }
  /** A search shows every section open, so collapsing waits until it is cleared. */
  searching?: boolean
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  // Where a right-click opened the menu; unset opens it under the ⋯ button.
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | undefined>(undefined)
  const btnRef = useRef<HTMLButtonElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const isGroup = section.kind === 'group'
  // Every section header collapses; only custom groups also rename / delete.
  const toggleCollapsed = (): void =>
    isGroup ? props.onToggleGroupCollapsed(section.id) : props.onToggleSectionCollapsed(section.id)
  const closeMenu = (): void => {
    setMenuOpen(false)
    setMenuAt(undefined)
  }
  // A rename started from the keyboard hands focus back to the header when it ends,
  // unless the user moved on to something else (a click elsewhere commits it too).
  const wasRenaming = useRef(renaming)
  useEffect(() => {
    if (wasRenaming.current && !renaming) {
      const active = document.activeElement
      if (!active || active === document.body) toggleRef.current?.focus()
    }
    wasRenaming.current = renaming
  }, [renaming])
  const chevron = (
    <span className="section-head__chevron" aria-hidden="true">
      {section.collapsed ? '▸' : '▾'}
    </span>
  )

  return (
    <div
      className={`section-head section-head--${section.kind}`}
      // Right-click (or the context-menu key, Shift+F10) opens a group's options, as on a chat row.
      onContextMenu={
        isGroup && !renaming
          ? (e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenuAt(e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : undefined)
              setMenuOpen(true)
            }
          : undefined
      }
    >
      {renaming ? (
        // The name's input sits beside the toggle's place, never inside a button.
        <div className="section-head__rename">
          {chevron}
          <InlineEdit
            value={section.name}
            onCommit={(t) => {
              props.onRenameGroup(section.id, t)
              onStopRename()
            }}
            onCancel={onStopRename}
          />
        </div>
      ) : (
        <button
          ref={toggleRef}
          className="section-head__toggle"
          aria-expanded={!section.collapsed}
          disabled={searching}
          onClick={toggleCollapsed}
          onKeyDown={(e) => {
            // F2 renames a group, as it renames a file in most file managers.
            if (isGroup && e.key === 'F2') {
              e.preventDefault()
              onStartRename()
            }
          }}
        >
          {chevron}
          <span className="section-head__name">{section.name}</span>
          <span className="section-head__count">
            {section.labelFilter.length > 0
              ? `${section.conversations.length} of ${section.total}`
              : section.total || ''}
          </span>
          {attention && (
            <span
              className="section-head__attention"
              role="img"
              aria-label={nestedTag(attention.signal, attention.count)}
              title={nestedTag(attention.signal, attention.count)}
            >
              <span className="conv__status" data-signal={attention.signal} aria-hidden="true" />
              {attention.count}
            </span>
          )}
        </button>
      )}

      {!renaming && <SectionLabelFilter section={section} props={props} />}

      {isGroup && !renaming && (
        <div className="conv__menu-wrap">
          <button
            ref={btnRef}
            className="conv__action"
            title="Group options"
            aria-label={`Options for group ${section.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          >
            ⋯
          </button>
          {menuOpen && (
            <Popover
              anchorRef={btnRef}
              onClose={closeMenu}
              role="menu"
              ariaLabel={`Options for group ${section.name}`}
              at={menuAt}
            >
              <button
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  onStartRename()
                  closeMenu()
                }}
              >
                <Icon name="pencil" /> Rename group
              </button>
              <button
                role="menuitem"
                className="menu__item menu__item--danger"
                onClick={() => {
                  props.onDeleteGroup(section.id)
                  closeMenu()
                }}
              >
                <Icon name="trash" /> Delete group
              </button>
            </Popover>
          )}
        </div>
      )}
    </div>
  )
}

/** The filter menu's grouping choices: your own groups only, or automatic sections too. */
const GROUP_BY_OPTIONS: { value: SidebarGroupBy | undefined; label: string }[] = [
  { value: undefined, label: 'Your groups only' },
  { value: 'folder', label: 'Project folder' },
  { value: 'date', label: 'Date' }
]

/** Funnel button beside the search box that filters the chat list by status, and sets grouping. */
function FilterButton({
  filter,
  counts,
  onChange,
  unreadCount,
  onMarkAllRead,
  unreadFirst,
  onToggleUnreadFirst,
  groupBy,
  onSetGroupBy,
  labelManager
}: {
  filter: ConversationStatusFilter
  counts: { active: number; archived: number }
  onChange: (filter: ConversationStatusFilter) => void
  /** How many chats are unread (or failed and unseen), for "Mark all as read". */
  unreadCount: number
  onMarkAllRead?: () => void
  unreadFirst: boolean
  onToggleUnreadFirst?: () => void
  groupBy?: SidebarGroupBy
  onSetGroupBy?: (by: SidebarGroupBy | undefined) => void
  /** Present when labels can be managed: the labels and their edit handlers. */
  labelManager?: {
    labels: ChatLabel[]
    onCreate: (name: string) => Promise<string>
    onUpdate: (id: string, patch: { name?: string; color?: LabelColor }) => void
    onDelete: (id: string) => void
  }
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [managing, setManaging] = useState(false)
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
          {onSetGroupBy && (
            <>
              <div className="menu__sep" />
              <div className="menu__label">Group chats by</div>
              {GROUP_BY_OPTIONS.map((o) => (
                <button
                  key={o.label}
                  role="menuitemradio"
                  aria-checked={groupBy === o.value}
                  className="menu__item"
                  onClick={() => {
                    onSetGroupBy(o.value)
                    setOpen(false)
                  }}
                >
                  {groupBy === o.value ? '● ' : '○ '}
                  {o.label}
                </button>
              ))}
            </>
          )}
          {labelManager && (
            <>
              <div className="menu__sep" />
              <button
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setOpen(false)
                  setManaging(true)
                }}
              >
                <Icon name="tag" /> Manage labels
              </button>
            </>
          )}
        </Popover>
      )}
      {managing && labelManager && (
        <LabelManager
          anchorRef={btnRef}
          onClose={() => setManaging(false)}
          labels={labelManager.labels}
          onCreate={labelManager.onCreate}
          onUpdate={labelManager.onUpdate}
          onDelete={labelManager.onDelete}
        />
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
 * land. Pinned is not a drop target — pinning is independent of grouping. An
 * automatic (folder or date) section takes only its own chats and chats leaving a
 * group, since its other chats are placed by their folder or date.
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
  toggleParent,
  tabStopId,
  onFocusRow
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
  /** The chat row that is the list's Tab stop. */
  tabStopId: string | null
  onFocusRow: (id: string) => void
}): JSX.Element {
  const { groups } = props
  // Slot the drop indicator sits at while dragging over this section, or null.
  const [dropAt, setDropAt] = useState<number | null>(null)

  const droppable = section.kind === 'group' || section.kind === 'ungrouped' || section.kind === 'auto'
  // A filtered section hides some of its chats, so a drop there can't be placed among
  // them: it only moves the chat in, and no insertion line is drawn.
  const filtered = section.labelFilter.length > 0
  // Group sections move the chat into the group; Ungrouped clears its group.
  const targetGroupId = section.kind === 'group' ? section.id : null
  const rowCount = section.conversations.length

  // Where this section's rows say they are dragged from. A grouped chat also says
  // which automatic section it would land in once out of its group.
  const dragTypesFor =
    (c: ConversationMeta) =>
    (): string[] => {
      const types = [DRAG_FROM_MIME + hexOf(section.kind === 'group' ? FROM_GROUP : section.id)]
      if (section.kind === 'group' && props.groupBy) {
        const latest = Math.max(c.updatedAt, ...descendantsOf(c.id, section.children).map((d) => d.updatedAt))
        const lands = autoSectionId(c, props.groupBy, props.now ?? Date.now(), () => latest)
        types.push(DRAG_LANDS_MIME + hexOf(lands))
      }
      return types
    }
  // An automatic section's chats are placed by their folder or date, so it takes a
  // drop only to reorder its own chats, or to take a chat out of a group. That chat
  // lands in the section its own folder or date picks, so it gets a slot here only
  // when that is this section.
  const fromHere = (types: readonly string[]): boolean => types.includes(DRAG_FROM_MIME + hexOf(section.id))
  const accepts = (types: readonly string[]): boolean =>
    types.includes(CONV_DRAG_MIME) &&
    (section.kind !== 'auto' || fromHere(types) || types.includes(DRAG_FROM_MIME + hexOf(FROM_GROUP)))
  const placesAtSlot = (types: readonly string[]): boolean =>
    section.kind !== 'auto' || fromHere(types) || types.includes(DRAG_LANDS_MIME + hexOf(section.id))

  const onDragOver = (e: DragEvent): void => {
    if (!accepts(e.dataTransfer.types)) return // not a chat drag this section takes
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDropAt(
      !filtered && placesAtSlot(e.dataTransfer.types) ? dropIndexFromEvent(e.currentTarget, e.clientY) : null
    )
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
    if (section.kind === 'auto') {
      if (!accepts(e.dataTransfer.types)) return
      // Out of its group and into the section its own folder or date picks.
      if (!placesAtSlot(e.dataTransfer.types)) {
        props.onMove(draggedId, null)
        return
      }
    }
    if (filtered) {
      const from = props.conversations.find((c) => c.id === draggedId)?.groupId ?? null
      if (from !== targetGroupId) props.onMove(draggedId, targetGroupId)
      return
    }

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

  // A collapsed section hides its rows, so its header carries the strongest state
  // that wants the user (needs input, failed, unread) among them, with a count.
  // Working never shows here: a header pulsing for every busy chat would be noise.
  const sectionAttention = (() => {
    if (!section.collapsed) return undefined
    const all = section.conversations.flatMap((c) => [c, ...descendantsOf(c.id, section.children)])
    const signals = all.map(ownSignal).filter((x) => x === 'input' || x === 'error' || x === 'unread')
    if (signals.length === 0) return undefined
    const signal = strongestSignal(signals)
    return { signal, count: signals.filter((x) => x === signal).length }
  })()

  // A row plus, unless folded away, the spawned chats nested under it (recursively).
  // A parent holding the open chat stays unfolded, so the open chat is never hidden.
  // Every row reserves the fold arrow's slot, so titles line up at every level.
  // Each row is a list item; a parent's spawned chats are a list inside its item.
  const renderTree = (c: ConversationMeta, depth: number): JSX.Element => {
    const kids = section.children[c.id] ?? []
    const all = kids.length ? descendantsOf(c.id, section.children) : []
    const expanded = !kids.length || childrenShown(c.id, section.children, collapsedParents, currentId)
    const own = ownSignal(c)
    const childSignals = all.map(ownSignal)
    const childSignal = strongestSignal(childSignals)
    // Folded, the parent's dot stands for its hidden children too; open, they show
    // their own dots, so the parent shows only its own state.
    const signal = expanded ? own : strongestSignal([own, childSignal])
    const reason = signalReason(props.chatStatus[c.id], own)
    return (
      <div className="conv-item" role="listitem">
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
          tabStop={c.id === tabStopId}
          onFocusRow={onFocusRow}
          dragTypes={dragTypesFor(c)}
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
          <div className="conv-children" role="list" aria-label={`Spawned from ${c.title}`}>
            {kids.map((k) => (
              <Fragment key={k.id}>{renderTree(k, depth + 1)}</Fragment>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="section"
      onDragOver={droppable ? onDragOver : undefined}
      onDragLeave={droppable ? onDragLeave : undefined}
      onDrop={droppable ? onDrop : undefined}
    >
      {section.headless ? null : (
        <GroupHeader
          section={section}
          props={props}
          renaming={renamingGroup === section.id}
          onStartRename={() => setRenamingGroup(section.id)}
          onStopRename={() => setRenamingGroup(null)}
          searching={!!props.search}
          {...(sectionAttention ? { attention: sectionAttention } : {})}
        />
      )}
      {!section.collapsed && rowCount > 0 && (
        <div className="section__rows" role="list" aria-label={section.name}>
          {section.conversations.map((c, i) => (
            <Fragment key={c.id}>
              {dropAt === i && <div className="conv-drop-line" aria-hidden="true" />}
              {renderTree(c, 0)}
            </Fragment>
          ))}
          {dropAt === rowCount && <div className="conv-drop-line" aria-hidden="true" />}
        </div>
      )}
      {section.kind === 'group' && !section.collapsed && section.total === 0 && (
        <div className="section__empty">Drop a chat here, or use the ⋯ menu</div>
      )}
      {filtered && !section.collapsed && rowCount === 0 && section.total > 0 && (
        <div className="section__empty section__empty--filtered">
          No chats match this filter.{' '}
          <button
            type="button"
            className="section__clear-filter"
            onClick={() => props.onSetSectionLabelFilter?.(section.id, [])}
          >
            Clear filter
          </button>
        </div>
      )}
    </div>
  )
}

const NO_PARENTS: ReadonlySet<string> = new Set()

/**
 * The chat rows the list shows, top to bottom (the same order ⌘1–9 and ⌃Tab follow:
 * see sidebarChatOrder).
 */
export function visibleRowIds(
  sections: SidebarSection[],
  collapsedParents: ReadonlySet<string>,
  currentId: string | null
): string[] {
  return sidebarChatOrder(sections, collapsedParents, currentId).map((c) => c.id)
}

/** Up/Down/Home/End on a focused chat row move focus to another row. */
function listKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
  const target = e.target as HTMLElement
  if (!target.dataset.convId) return
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-conv-id]')]
  const next = listMove(e.key, rows.indexOf(target), rows.length)
  if (next === null) return
  e.preventDefault()
  rows[next]?.focus()
}

export function Sidebar(props: SidebarProps): JSX.Element {
  const { conversations, groups, currentId } = props
  const searchRef = useRef<HTMLInputElement>(null)
  // Runs after the render that un-collapses the sidebar, so the field exists by now.
  useEffect(() => {
    if (props.focusSearchSignal) searchRef.current?.focus()
  }, [props.focusSearchSignal])
  const shortcut = props.toggleShortcut ? ` (${props.toggleShortcut})` : ''
  const newChatTitle = `New chat${props.newChatShortcut ? ` (${props.newChatShortcut})` : ''}`
  const settingsTitle = `Settings${props.settingsShortcut ? ` (${props.settingsShortcut})` : ''}`
  const sections = sidebarSections({
    conversations,
    groups,
    collapsedSections: props.collapsedSections,
    search: props.search,
    chatStatus: props.chatStatus,
    currentId,
    ...(props.unreadFirst ? { unreadFirst: true } : {}),
    ...(props.groupBy ? { groupBy: props.groupBy } : {}),
    ...(props.now !== undefined ? { now: props.now } : {}),
    ...(props.labelFilters ? { labelFilters: props.labelFilters } : {})
  })
  const unreadCount = Object.values(props.chatStatus).filter((st) => st.unread !== undefined).length
  const needInput = Object.values(props.chatStatus).filter((st) => st.pending.length > 0).length
  // The collapsed rail hides every row, so its expand button says what's waiting.
  const railTitle =
    needInput > 0
      ? `, ${needInput} ${needInput === 1 ? 'chat needs' : 'chats need'} input`
      : unreadCount > 0
        ? `, ${unreadCount} unread`
        : ''
  // Which conversation/group is currently being renamed (id), if any.
  const [renamingConv, setRenamingConv] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  // Parents whose spawned chats are folded away (saved in settings; expanded by default).
  const collapsedParents = props.collapsedParents ?? NO_PARENTS
  const toggleParent = (id: string): void => props.onToggleParentCollapsed?.(id)
  // The chat list is one Tab stop (the row last focused, else the open chat, else
  // the first row); Up/Down/Home/End move between rows.
  const [focusedConv, setFocusedConv] = useState<string | null>(null)
  const tabStopId = tabStop(visibleRowIds(sections, collapsedParents, currentId), focusedConv, currentId)

  // Collapsed: a thin rail with just the expand toggle and the most-used actions.
  if (props.collapsed) {
    return (
      <aside className="sidebar sidebar--collapsed">
        <button
          className="sidebar__rail-btn"
          onClick={props.onToggleCollapse}
          title={`Expand sidebar${shortcut}${railTitle}`}
          aria-label={`Expand sidebar${railTitle}`}
        >
          »
          {needInput > 0 ? (
            <span className="sidebar__rail-badge" aria-hidden="true">
              {needInput}
            </span>
          ) : (
            unreadCount > 0 && <span className="sidebar__rail-pip" aria-hidden="true" />
          )}
        </button>
        <button
          className="sidebar__rail-btn"
          onClick={props.onNew}
          title={newChatTitle}
          aria-label="New chat"
        >
          ＋
        </button>
        <div className="sidebar__rail-spacer" />
        <ShareButton variant="rail" />
        <button
          className="sidebar__rail-btn"
          onClick={props.onOpenSettings}
          title={settingsTitle}
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
      <button className="btn btn--accent sidebar__new" onClick={props.onNew} title={newChatTitle}>
        ＋ New chat
      </button>

      <div className="sidebar__searchrow">
        <input
          ref={searchRef}
          className="sidebar__search"
          type="search"
          placeholder="Search chats…"
          aria-label="Search chats"
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
          groupBy={props.groupBy}
          {...(props.onSetGroupBy ? { onSetGroupBy: props.onSetGroupBy } : {})}
          {...(props.onCreateLabel && props.onUpdateLabel && props.onDeleteLabel
            ? {
                labelManager: {
                  labels: props.labels ?? NO_LABELS,
                  onCreate: props.onCreateLabel,
                  onUpdate: props.onUpdateLabel,
                  onDelete: props.onDeleteLabel
                }
              }
            : {})}
        />
      </div>

      <div className="sidebar__list" onKeyDown={listKeyDown}>
        {conversations.length === 0 && (
          <div className="sidebar__empty">
            {props.search
              ? 'No matching chats.'
              : props.statusFilter === 'archived'
                ? 'No archived chats.'
                : props.statusCounts.archived > 0
                  ? `No active chats. ${props.statusCounts.archived} archived.`
                  : 'No chats yet.'}
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
            tabStopId={tabStopId}
            onFocusRow={setFocusedConv}
          />
        ))}
      </div>

      <div className="sidebar__foot">
        <ShareButton />
        <button className="btn btn--sm sidebar__import" onClick={props.onImport}>
          <Icon name="import" /> Import chat
        </button>
        <button className="btn btn--sm sidebar__settings" onClick={props.onOpenSettings} title={settingsTitle}>
          <Icon name="settings" /> Settings
        </button>
      </div>
    </aside>
  )
}
