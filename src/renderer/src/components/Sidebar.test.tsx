import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConversationMeta } from '@shared/agent'
import type { ChatGroup } from '@shared/types'
import { Sidebar, type SidebarProps } from './Sidebar'

function makeConv(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'c1',
    title: 'First chat',
    workspace: '/Users/me/projects/houston',
    providerId: 'anthropic',
    model: 'claude-opus',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function baseProps(overrides: Partial<SidebarProps> = {}): SidebarProps {
  return {
    conversations: [],
    groups: [],
    search: '',
    onSearch: vi.fn(),
    currentId: null,
    collapsed: false,
    onToggleCollapse: vi.fn(),
    runningIds: new Set<string>(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onDelete: vi.fn(),
    onFork: vi.fn(),
    onExport: vi.fn(),
    onExportHtml: vi.fn(),
    onImport: vi.fn(),
    onOpenSettings: vi.fn(),
    onRename: vi.fn(),
    onSetPinned: vi.fn(),
    onSetArchived: vi.fn(),
    statusFilter: 'active',
    onStatusFilterChange: vi.fn(),
    statusCounts: { active: 0, archived: 0 },
    onMove: vi.fn(),
    onReorder: vi.fn(),
    onCreateGroup: vi.fn().mockResolvedValue('grp-new'),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onToggleGroupCollapsed: vi.fn(),
    collapsedSections: {},
    onToggleSectionCollapsed: vi.fn(),
    ...overrides
  }
}

/** Open the ⋯ overflow menu for a given conversation row. */
function openConvMenu(title: string): void {
  const row = screen.getByText(title).closest('.conv') as HTMLElement
  fireEvent.click(within(row).getByTitle('More'))
}

/** Open an expand-on-highlight submenu (e.g. "Open in", "Move to group") by its row. */
function openSubmenu(name: string): void {
  fireEvent.click(screen.getByRole('button', { name }))
}

/** Open the ⋯ options menu for a given group header. */
function openGroupMenu(name: string): void {
  const head = screen.getByText(name).closest('.section-head') as HTMLElement
  fireEvent.click(within(head).getByTitle('Group options'))
}

describe('Sidebar — expanded rendering', () => {
  it('lists conversations and reflects the active one', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha' }), makeConv({ id: 'b', title: 'Beta' })],
      currentId: 'b'
    })
    render(<Sidebar {...props} />)

    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()

    // The active row carries the active modifier class.
    const active = screen.getByText('Beta').closest('.conv') as HTMLElement
    expect(active).toHaveClass('conv--active')
    const inactive = screen.getByText('Alpha').closest('.conv') as HTMLElement
    expect(inactive).not.toHaveClass('conv--active')
  })

  it('selects a conversation from the keyboard (focusable row + Enter)', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha' }), makeConv({ id: 'b', title: 'Beta' })],
      currentId: 'b'
    })
    render(<Sidebar {...props} />)

    const alpha = screen.getByText('Alpha').closest('.conv') as HTMLElement
    expect(alpha).toHaveAttribute('tabindex', '0')
    // Dispatched on the row itself, so the handler's target === currentTarget guard passes.
    fireEvent.keyDown(alpha, { key: 'Enter' })
    expect(props.onSelect).toHaveBeenCalledWith('a')
  })

  it('marks every chat with a live run, regardless of which is active', () => {
    const props = baseProps({
      conversations: [
        makeConv({ id: 'a', title: 'Alpha' }),
        makeConv({ id: 'b', title: 'Beta' })
      ],
      // Beta is the open chat; Alpha is running in the background.
      currentId: 'b',
      runningIds: new Set(['a'])
    })
    render(<Sidebar {...props} />)

    const alpha = screen.getByText('Alpha').closest('.conv') as HTMLElement
    const beta = screen.getByText('Beta').closest('.conv') as HTMLElement
    // The running (background) chat shows the indicator; the idle open one doesn't.
    expect(within(alpha).getByLabelText('Running')).toBeInTheDocument()
    expect(within(beta).queryByLabelText('Running')).not.toBeInTheDocument()
  })

  it('reserves the running-dot slot on every row so the title never shifts', () => {
    const props = baseProps({
      conversations: [
        makeConv({ id: 'a', title: 'Alpha' }),
        makeConv({ id: 'b', title: 'Beta' })
      ],
      runningIds: new Set(['a'])
    })
    render(<Sidebar {...props} />)

    // Both rows carry the dot element; only the running one is marked active.
    const alpha = screen.getByText('Alpha').closest('.conv') as HTMLElement
    const beta = screen.getByText('Beta').closest('.conv') as HTMLElement
    expect(alpha.querySelector('.conv__running')).not.toBeNull()
    expect(beta.querySelector('.conv__running')).not.toBeNull()
    expect(alpha.querySelector('.conv__running')).toHaveAttribute('data-running')
    expect(beta.querySelector('.conv__running')).not.toHaveAttribute('data-running')
  })

  it('shows no running indicator when nothing is running', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)
    expect(screen.queryByLabelText('Running')).not.toBeInTheDocument()
  })

  it('selecting a conversation fires onSelect with its id', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha' }), makeConv({ id: 'b', title: 'Beta' })]
    })
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByText('Beta'))
    expect(props.onSelect).toHaveBeenCalledWith('b')
  })

  it('the new-chat button fires onNew, and search edits fire onSearch', () => {
    const props = baseProps()
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByText('＋ New chat'))
    expect(props.onNew).toHaveBeenCalledOnce()

    fireEvent.change(screen.getByLabelText('Search conversations'), { target: { value: 'beta' } })
    expect(props.onSearch).toHaveBeenCalledWith('beta')
  })

  it('renders a pinned section with the star marker for pinned chats', () => {
    const props = baseProps({
      conversations: [
        makeConv({ id: 'p', title: 'Important', pinned: true }),
        makeConv({ id: 'u', title: 'Plain' })
      ]
    })
    render(<Sidebar {...props} />)

    expect(screen.getByText('Pinned')).toBeInTheDocument()
    // The pinned row shows the ★ pin marker; the plain one does not.
    const pinnedRow = screen.getByText('Important').closest('.conv') as HTMLElement
    expect(within(pinnedRow).getByTitle('Pinned')).toBeInTheDocument()
    const plainRow = screen.getByText('Plain').closest('.conv') as HTMLElement
    expect(within(plainRow).queryByTitle('Pinned')).not.toBeInTheDocument()
  })

  it('shows the repo name alongside the branch for a worktree chat', () => {
    const props = baseProps({
      conversations: [
        makeConv({
          id: 'wt',
          title: 'Worktree chat',
          worktree: {
            path: '/Users/me/projects/houston/.worktrees/feat-x',
            branch: 'feat/x',
            repoRoot: '/Users/me/projects/houston'
          }
        })
      ]
    })
    render(<Sidebar {...props} />)

    const row = screen.getByText('Worktree chat').closest('.conv') as HTMLElement
    const meta = row.querySelector('.conv__meta') as HTMLElement
    // Repo basename (from repoRoot) precedes the branch on the meta line.
    expect(meta).toHaveTextContent('houston')
    const branch = within(meta).getByText('⑂ feat/x')
    expect(branch).toHaveClass('conv__branch')
  })

  it('shows the workspace basename (no branch) for a non-worktree chat', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Plain chat' })]
    })
    render(<Sidebar {...props} />)

    const row = screen.getByText('Plain chat').closest('.conv') as HTMLElement
    const meta = row.querySelector('.conv__meta') as HTMLElement
    expect(meta).toHaveTextContent('houston')
    expect(meta.querySelector('.conv__branch')).toBeNull()
  })

  it('groups custom-grouped chats under their group header (with count)', () => {
    const groups: ChatGroup[] = [{ id: 'g1', name: 'Work' }]
    const props = baseProps({
      groups,
      conversations: [
        makeConv({ id: 'w', title: 'Work item', groupId: 'g1' }),
        makeConv({ id: 'o', title: 'Loose chat' })
      ]
    })
    render(<Sidebar {...props} />)

    expect(screen.getByText('Work')).toBeInTheDocument()
    // Ungrouped section is named "Ungrouped" once a group exists.
    expect(screen.getByText('Ungrouped')).toBeInTheDocument()
    expect(screen.getByText('Work item')).toBeInTheDocument()
    expect(screen.getByText('Loose chat')).toBeInTheDocument()
  })
})

describe('Sidebar — empty states', () => {
  it('shows the no-conversations message when the list is empty', () => {
    render(<Sidebar {...baseProps({ conversations: [] })} />)
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument()
  })

  it('shows the no-matches message when a search is active but the list is empty', () => {
    render(<Sidebar {...baseProps({ conversations: [], search: 'xyz' })} />)
    expect(screen.getByText('No matching conversations.')).toBeInTheDocument()
  })

  it('shows a drop hint inside an empty group', () => {
    const groups: ChatGroup[] = [{ id: 'g1', name: 'Empty Group' }]
    render(<Sidebar {...baseProps({ groups, conversations: [makeConv()] })} />)
    expect(screen.getByText('Drop a chat here, or use the ⋯ menu')).toBeInTheDocument()
  })
})

describe('Sidebar — collapse / expand rail', () => {
  it('renders the full sidebar with a Collapse control when expanded', () => {
    const props = baseProps()
    render(<Sidebar {...props} />)

    const collapse = screen.getByLabelText('Collapse sidebar')
    expect(collapse).toBeInTheDocument()
    // The full sidebar shows search; the rail does not.
    expect(screen.getByLabelText('Search conversations')).toBeInTheDocument()

    fireEvent.click(collapse)
    expect(props.onToggleCollapse).toHaveBeenCalledOnce()
  })

  it('renders the thin rail with an Expand control when collapsed', () => {
    const props = baseProps({ collapsed: true })
    render(<Sidebar {...props} />)

    // Rail shows Expand (not Collapse) and hides the search field + conversation list.
    expect(screen.getByLabelText('Expand sidebar')).toBeInTheDocument()
    expect(screen.queryByLabelText('Collapse sidebar')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Search conversations')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Expand sidebar'))
    expect(props.onToggleCollapse).toHaveBeenCalledOnce()
  })

  it('the rail still exposes New chat and Settings affordances', () => {
    const props = baseProps({ collapsed: true })
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByLabelText('New chat'))
    expect(props.onNew).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Settings'))
    expect(props.onOpenSettings).toHaveBeenCalledOnce()
  })
})

describe('Sidebar — group collapse', () => {
  it('clicking a group header toggles its collapsed state and reflects it visually', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'w', title: 'Work item', groupId: 'g1' })]
    })
    const { rerender } = render(<Sidebar {...props} />)

    // Expanded: conversations visible, chevron points down (▾), not right (▸).
    const head = screen.getByText('Work').closest('.section-head') as HTMLElement
    expect(within(head).getByText('▾')).toBeInTheDocument()
    expect(screen.getByText('Work item')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Work'))
    expect(props.onToggleGroupCollapsed).toHaveBeenCalledWith('g1')

    // Re-render in the toggled (collapsed) state the callback would produce:
    // the chevron flips to ▸ and the group's conversations disappear.
    rerender(
      <Sidebar
        {...baseProps({
          ...props,
          groups: [{ id: 'g1', name: 'Work', collapsed: true }],
          conversations: [makeConv({ id: 'w', title: 'Work item', groupId: 'g1' })],
          onToggleGroupCollapsed: props.onToggleGroupCollapsed
        })}
      />
    )
    const collapsedHead = screen.getByText('Work').closest('.section-head') as HTMLElement
    expect(within(collapsedHead).getByText('▸')).toBeInTheDocument()
    expect(within(collapsedHead).queryByText('▾')).not.toBeInTheDocument()
    expect(screen.queryByText('Work item')).not.toBeInTheDocument()
  })

  it('hides a collapsed group’s conversations', () => {
    const groups: ChatGroup[] = [{ id: 'g1', name: 'Work', collapsed: true }]
    const props = baseProps({
      groups,
      conversations: [makeConv({ id: 'w', title: 'Hidden item', groupId: 'g1' })]
    })
    render(<Sidebar {...props} />)

    // Header still renders, but the collapsed group's chat is not shown.
    expect(screen.getByText('Work')).toBeInTheDocument()
    expect(screen.queryByText('Hidden item')).not.toBeInTheDocument()
  })

  it('has no footer "New group" control (groups are created from the conv menu)', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    // The only "＋ New group" affordance lives inside a conversation's ⋯ menu,
    // which is closed here — so none is visible in the footer.
    expect(screen.queryByText('＋ New group')).not.toBeInTheDocument()
  })
})

describe('Sidebar — built-in section collapse', () => {
  it('clicking the Ungrouped header toggles it via onToggleSectionCollapsed', () => {
    // A group exists, so the Ungrouped header is rendered (and now collapsible).
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'u', title: 'Loose chat' })]
    })
    render(<Sidebar {...props} />)

    const head = screen.getByText('Ungrouped').closest('.section-head') as HTMLElement
    expect(within(head).getByText('▾')).toBeInTheDocument() // expanded chevron
    fireEvent.click(screen.getByText('Ungrouped'))
    expect(props.onToggleSectionCollapsed).toHaveBeenCalledWith('ungrouped')
    // It's a built-in section, not a group, so the group handler is untouched.
    expect(props.onToggleGroupCollapsed).not.toHaveBeenCalled()
  })

  it('hides Ungrouped chats and flips the chevron when collapsed', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'u', title: 'Loose chat' })],
      collapsedSections: { ungrouped: true }
    })
    render(<Sidebar {...props} />)

    const head = screen.getByText('Ungrouped').closest('.section-head') as HTMLElement
    expect(within(head).getByText('▸')).toBeInTheDocument() // collapsed chevron
    expect(screen.queryByText('Loose chat')).not.toBeInTheDocument()
  })

  it('collapses the Pinned section too', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'p', title: 'Important', pinned: true })],
      collapsedSections: { pinned: true }
    })
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByText('Pinned'))
    expect(props.onToggleSectionCollapsed).toHaveBeenCalledWith('pinned')
    // Collapsed → the pinned chat is hidden.
    expect(screen.queryByText('Important')).not.toBeInTheDocument()
  })
})

describe('Sidebar — row overflow menu', () => {
  it('pins/unpins, forks, exports and deletes from the ⋯ menu', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('★ Pin'))
    expect(props.onSetPinned).toHaveBeenCalledWith('a', true)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('⑂ Fork'))
    expect(props.onFork).toHaveBeenCalledWith('a')

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('Export'))
    expect(props.onExport).toHaveBeenCalledWith('a')

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('✕ Delete'))
    expect(props.onDelete).toHaveBeenCalledWith('a')
  })

  it('shows "Unpin" for an already-pinned chat and unpins it', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha', pinned: true })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('☆ Unpin'))
    expect(props.onSetPinned).toHaveBeenCalledWith('a', false)
  })

  it('archives an active chat from the ⋯ menu', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('Archive'))
    expect(props.onSetArchived).toHaveBeenCalledWith('a', true)
  })

  it('shows "Unarchive" for an archived chat and unarchives it', () => {
    const props = baseProps({
      statusFilter: 'archived',
      conversations: [makeConv({ id: 'a', title: 'Alpha', archived: true })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('Unarchive'))
    expect(props.onSetArchived).toHaveBeenCalledWith('a', false)
  })
})

describe('Sidebar — status filter', () => {
  it('switches to the archived view from the filter popover', () => {
    const props = baseProps({ statusCounts: { active: 3, archived: 2 } })
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByLabelText('Filter chats'))
    // The popover lists both statuses with their counts.
    expect(screen.getByText('○ Archived')).toBeInTheDocument()
    fireEvent.click(screen.getByText('○ Archived'))
    expect(props.onStatusFilterChange).toHaveBeenCalledWith('archived')
  })

  it('flags the filter button as active when not on the default view', () => {
    const props = baseProps({ statusFilter: 'archived' })
    render(<Sidebar {...props} />)
    expect(screen.getByLabelText('Filter chats')).toHaveClass('sidebar__filter--on')
  })

  it('leaves the filter button unflagged on the default active view', () => {
    const props = baseProps({ statusFilter: 'active' })
    render(<Sidebar {...props} />)
    expect(screen.getByLabelText('Filter chats')).not.toHaveClass('sidebar__filter--on')
  })

  it('tags an archived chat that surfaces in the active view (e.g. via search)', () => {
    // In the active view, an archived chat only appears through search; it gets a
    // tag so it's distinguishable from live chats.
    const props = baseProps({
      statusFilter: 'active',
      search: 'alp',
      conversations: [makeConv({ id: 'a', title: 'Alpha', archived: true })]
    })
    render(<Sidebar {...props} />)

    const row = screen.getByText('Alpha').closest('.conv') as HTMLElement
    expect(within(row).getByText('Archived')).toBeInTheDocument()
  })

  it('does not tag archived chats in the archived view', () => {
    const props = baseProps({
      statusFilter: 'archived',
      conversations: [makeConv({ id: 'a', title: 'Alpha', archived: true })]
    })
    render(<Sidebar {...props} />)

    const row = screen.getByText('Alpha').closest('.conv') as HTMLElement
    expect(within(row).queryByText('Archived')).not.toBeInTheDocument()
  })
})

describe('Sidebar — inline rename', () => {
  it('double-clicking a title opens an inline editor that commits on Enter', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRename).toHaveBeenCalledWith('a', 'Renamed')
  })

  it('cancels the rename on Escape without calling onRename', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    fireEvent.doubleClick(screen.getByText('Alpha'))
    const input = screen.getByDisplayValue('Alpha') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Discarded' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(props.onRename).not.toHaveBeenCalled()
    // Edit mode exited: the inline input (with the discarded text and the
    // original value) is gone, and the original title is shown again.
    expect(screen.queryByDisplayValue('Discarded')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Alpha')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })
})

describe('Sidebar — export / import', () => {
  it('“Export as HTML” fires onExportHtml with the conv id', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('Export as HTML'))
    expect(props.onExportHtml).toHaveBeenCalledWith('a')
    // Plain "Export" stays distinct and was not invoked.
    expect(props.onExport).not.toHaveBeenCalled()
  })

  it('the footer Import control fires onImport', () => {
    const props = baseProps()
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByText('Import chat'))
    expect(props.onImport).toHaveBeenCalledOnce()
  })
})

describe('Sidebar — moving chats between groups', () => {
  it('“Move to <group>” fires onMove with the conv id and that group id', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    // "Move to group" opens a flyout with a button per group ("○ Work" when not in it).
    openSubmenu('Move to group')
    fireEvent.click(screen.getByRole('button', { name: '○ Work' }))
    expect(props.onMove).toHaveBeenCalledWith('a', 'g1')
  })

  it('“＋ New group” creates a group, moves the chat in, and enters rename mode', async () => {
    // onCreateGroup resolves to the new id; the group must exist in `groups` for
    // its header (and inline editor) to render, so we seed it.
    const onCreateGroup = vi.fn().mockResolvedValue('grp-new')
    const props = baseProps({
      onCreateGroup,
      groups: [{ id: 'grp-new', name: 'New group' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    openSubmenu('Move to group')
    fireEvent.click(screen.getByText('＋ New group'))
    expect(onCreateGroup).toHaveBeenCalledOnce()

    // After the create resolves, the new group's header shows an inline editor
    // so the user can name it — and the chat has been moved into that group.
    const editor = (await screen.findByDisplayValue('New group')) as HTMLInputElement
    expect(editor).toHaveClass('inline-edit')
    expect(props.onMove).toHaveBeenCalledWith('a', 'grp-new')
  })

  it('“Remove from group” on a grouped conv fires onMove with null', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha', groupId: 'g1' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    openSubmenu('Move to group')
    fireEvent.click(screen.getByText('Remove from group'))
    expect(props.onMove).toHaveBeenCalledWith('a', null)
  })

  it('“Remove from group” is hidden for an ungrouped conv', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    openSubmenu('Move to group')
    expect(screen.queryByText('Remove from group')).not.toBeInTheDocument()
  })
})

describe('Sidebar — Open in (per-chat menu)', () => {
  // These tests install a fake editor bridge; clear it so later tests see no api.
  afterEach(() => {
    window.api = undefined as unknown as typeof window.api
  })

  /** Stub the editor bridge the ⋯ menu calls; returns the spies for assertions. */
  function installEditorApi(available = ['vscode', 'cursor']) {
    const listEditors = vi.fn(() =>
      Promise.resolve([
        { id: 'vscode', label: 'VS Code', available: available.includes('vscode') },
        { id: 'cursor', label: 'Cursor', available: available.includes('cursor') },
        { id: 'zed', label: 'Zed', available: available.includes('zed') }
      ])
    )
    const openInEditor = vi.fn(() => Promise.resolve({ ok: true }))
    const revealInFileManager = vi.fn(() => Promise.resolve({ ok: true }))
    window.api = { listEditors, openInEditor, revealInFileManager } as unknown as typeof window.api
    return { listEditors, openInEditor, revealInFileManager }
  }

  it('opens the chat workspace in a detected editor', async () => {
    const api = installEditorApi()
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha', workspace: '/Users/me/proj' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    await waitFor(() => expect(api.listEditors).toHaveBeenCalled())
    openSubmenu('Open in')
    fireEvent.click(await screen.findByRole('button', { name: 'VS Code' }))
    await waitFor(() => expect(api.openInEditor).toHaveBeenCalledWith('vscode', '/Users/me/proj'))
  })

  it('lists only installed editors and a Reveal item', async () => {
    installEditorApi(['vscode']) // cursor + zed not installed
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    openSubmenu('Open in')
    expect(await screen.findByRole('button', { name: 'VS Code' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cursor' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Zed' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^(finder|file explorer|file manager)$/i })).toBeInTheDocument()
  })

  it('reveals the chat workspace in the file manager', async () => {
    const api = installEditorApi([])
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha', workspace: '/Users/me/proj' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    openSubmenu('Open in')
    fireEvent.click(await screen.findByRole('button', { name: /^(finder|file explorer|file manager)$/i }))
    await waitFor(() => expect(api.revealInFileManager).toHaveBeenCalledWith('/Users/me/proj'))
  })

  it('keeps the menu open and shows why when a launch fails', async () => {
    installEditorApi(['vscode'])
    window.api.openInEditor = vi.fn(() =>
      Promise.resolve({ ok: false, error: "VS Code isn't installed." })
    )
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    openSubmenu('Open in')
    fireEvent.click(await screen.findByRole('button', { name: 'VS Code' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("VS Code isn't installed.")
  })
})

/** A minimal stand-in for the browser DataTransfer used in drag events. */
function makeDataTransfer(): {
  effectAllowed: string
  dropEffect: string
  setData: (type: string, value: string) => void
  getData: (type: string) => string
  readonly types: string[]
} {
  const store: Record<string, string> = {}
  return {
    effectAllowed: '',
    dropEffect: '',
    setData: (type, value) => {
      store[type] = value
    },
    getData: (type) => store[type] ?? '',
    get types() {
      return Object.keys(store)
    }
  }
}

/** Pick up the given conversation row, returning the populated DataTransfer. */
function startConvDrag(title: string): ReturnType<typeof makeDataTransfer> {
  const row = screen.getByText(title).closest('.conv') as HTMLElement
  const dataTransfer = makeDataTransfer()
  fireEvent.dragStart(row, { dataTransfer })
  return dataTransfer
}

const sectionOf = (label: string): HTMLElement =>
  screen.getByText(label).closest('.section') as HTMLElement

/**
 * jsdom gives every element a zero-size rect, so the drop-slot math (which reads
 * row geometry) can't tell rows apart. Stamp each row a 40px-tall rect stacked
 * top-to-bottom so a `clientY` can target a specific gap.
 */
function stackRowRects(section: HTMLElement): void {
  section.querySelectorAll('.conv').forEach((el, i) => {
    ;(el as HTMLElement).getBoundingClientRect = () =>
      ({
        top: i * 40,
        height: 40,
        bottom: i * 40 + 40,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: i * 40,
        toJSON: () => ({})
      }) as DOMRect
  })
}

/**
 * Fire a drag event carrying both a DataTransfer and a vertical pointer
 * position. jsdom's DragEvent fallback drops `clientY` from the init, so we set
 * it on the event object directly (React reads it off the native event).
 */
function fireDrag(
  type: 'dragOver' | 'drop',
  target: HTMLElement,
  dataTransfer: ReturnType<typeof makeDataTransfer>,
  clientY: number
): void {
  const event = createEvent[type](target, { dataTransfer })
  Object.defineProperty(event, 'clientY', { value: clientY })
  fireEvent(target, event)
}

describe('Sidebar — drag a chat onto a group', () => {
  it('dropping a chat onto a group reorders it into that group', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    const dataTransfer = startConvDrag('Alpha')
    fireEvent.drop(sectionOf('Work'), { dataTransfer, clientY: 0 })
    // The empty group's new order is just the dragged chat, moved into g1.
    expect(props.onReorder).toHaveBeenCalledWith(['a'], { id: 'a', groupId: 'g1' })
  })

  it('dropping into an empty group works (the drop target is the whole section)', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Empty Group' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    const dataTransfer = startConvDrag('Alpha')
    // The empty group's only body is the "Drop a chat here…" hint.
    fireEvent.drop(sectionOf('Empty Group'), { dataTransfer, clientY: 0 })
    expect(props.onReorder).toHaveBeenCalledWith(['a'], { id: 'a', groupId: 'g1' })
  })

  it('dropping a grouped chat onto Ungrouped removes it from its group', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [
        makeConv({ id: 'a', title: 'Alpha', groupId: 'g1' }),
        // A loose chat so the "Ungrouped" section (the drop target) renders.
        makeConv({ id: 'b', title: 'Loose', updatedAt: 2 })
      ]
    })
    render(<Sidebar {...props} />)

    const dataTransfer = startConvDrag('Alpha')
    const section = sectionOf('Ungrouped')
    stackRowRects(section)
    // Drop below the loose chat → Alpha joins Ungrouped after it, group cleared.
    fireDrag('drop', section, dataTransfer, 100)
    expect(props.onReorder).toHaveBeenCalledWith(['b', 'a'], { id: 'a', groupId: null })
  })

  it('reorders within a group by dropping at the pointed slot', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [
        makeConv({ id: 'a', title: 'Alpha', groupId: 'g1', updatedAt: 3 }),
        makeConv({ id: 'b', title: 'Beta', groupId: 'g1', updatedAt: 2 }),
        makeConv({ id: 'c', title: 'Gamma', groupId: 'g1', updatedAt: 1 })
      ]
    })
    render(<Sidebar {...props} />)

    // Rows render a, b, c (recency). Drag Gamma to the very top.
    const section = sectionOf('Work')
    stackRowRects(section)
    const dataTransfer = startConvDrag('Gamma')
    fireDrag('drop', section, dataTransfer, 2)
    // Same group, so no cross-section move — just the new in-section order.
    expect(props.onReorder).toHaveBeenCalledWith(['c', 'a', 'b'], undefined)
  })

  it('does not persist a no-op drop (chat dropped back onto its own slot)', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [
        makeConv({ id: 'a', title: 'Alpha', groupId: 'g1', updatedAt: 2 }),
        makeConv({ id: 'b', title: 'Beta', groupId: 'g1', updatedAt: 1 })
      ]
    })
    render(<Sidebar {...props} />)

    const section = sectionOf('Work')
    stackRowRects(section)
    const dataTransfer = startConvDrag('Alpha')
    // Drop within Alpha's own row → order unchanged → nothing to persist.
    fireDrag('drop', section, dataTransfer, 10)
    expect(props.onReorder).not.toHaveBeenCalled()
  })

  it('shows only a drop-indicator line — not a whole-section highlight', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [
        makeConv({ id: 'a', title: 'Alpha', groupId: 'g1', updatedAt: 2 }),
        makeConv({ id: 'b', title: 'Beta', groupId: 'g1', updatedAt: 1 })
      ]
    })
    const { container } = render(<Sidebar {...props} />)

    const section = sectionOf('Work')
    stackRowRects(section)
    const dataTransfer = startConvDrag('Beta')
    expect(container.querySelector('.conv-drop-line')).toBeNull()

    fireDrag('dragOver', section, dataTransfer, 2)
    // The section itself is never box-highlighted; only the insertion line shows.
    expect(section).not.toHaveClass('section--drop')
    expect(container.querySelector('.conv-drop-line')).not.toBeNull()

    fireEvent.dragLeave(section, { dataTransfer, relatedTarget: document.body })
    expect(container.querySelector('.conv-drop-line')).toBeNull()
  })

  it('dims the dragged chat while it is being dragged', () => {
    const props = baseProps({
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    const row = screen.getByText('Alpha').closest('.conv') as HTMLElement
    expect(row).not.toHaveClass('conv--dragging')

    startConvDrag('Alpha')
    expect(row).toHaveClass('conv--dragging')

    fireEvent.dragEnd(row)
    expect(row).not.toHaveClass('conv--dragging')
  })

  it('does not accept drops on the Pinned section (pinning is independent of groups)', () => {
    const props = baseProps({
      conversations: [
        makeConv({ id: 'p', title: 'Pinned chat', pinned: true }),
        makeConv({ id: 'a', title: 'Alpha' })
      ]
    })
    const { container } = render(<Sidebar {...props} />)

    const dataTransfer = startConvDrag('Alpha')
    const pinned = sectionOf('Pinned')
    fireEvent.dragOver(pinned, { dataTransfer })
    // No drop target → no insertion line — and a drop does nothing.
    expect(container.querySelector('.conv-drop-line')).toBeNull()
    fireEvent.drop(pinned, { dataTransfer })
    expect(props.onReorder).not.toHaveBeenCalled()
  })

  it('makes chat rows draggable but not while renaming', () => {
    const props = baseProps({ conversations: [makeConv({ id: 'a', title: 'Alpha' })] })
    render(<Sidebar {...props} />)

    const row = screen.getByText('Alpha').closest('.conv') as HTMLElement
    expect(row).toHaveAttribute('draggable', 'true')

    // Entering rename mode disables dragging so the text input keeps selection.
    fireEvent.doubleClick(screen.getByText('Alpha'))
    const renamingRow = screen.getByDisplayValue('Alpha').closest('.conv') as HTMLElement
    expect(renamingRow).toHaveAttribute('draggable', 'false')
  })
})

describe('Sidebar — group header menu', () => {
  it('renames a group via the header menu, committing on Enter', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'w', title: 'Work item', groupId: 'g1' })]
    })
    render(<Sidebar {...props} />)

    openGroupMenu('Work')
    fireEvent.click(screen.getByText('✎ Rename group'))

    const input = screen.getByDisplayValue('Work') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Renamed Group' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(props.onRenameGroup).toHaveBeenCalledWith('g1', 'Renamed Group')
  })

  it('deletes a group via the header menu, firing onDeleteGroup with the group id', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'w', title: 'Work item', groupId: 'g1' })]
    })
    render(<Sidebar {...props} />)

    openGroupMenu('Work')
    fireEvent.click(screen.getByText('✕ Delete group'))
    expect(props.onDeleteGroup).toHaveBeenCalledWith('g1')
  })
})
