import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
    onMove: vi.fn(),
    onCreateGroup: vi.fn().mockResolvedValue('grp-new'),
    onRenameGroup: vi.fn(),
    onDeleteGroup: vi.fn(),
    onToggleGroupCollapsed: vi.fn(),
    ...overrides
  }
}

/** Open the ⋯ overflow menu for a given conversation row. */
function openConvMenu(title: string): void {
  const row = screen.getByText(title).closest('.conv') as HTMLElement
  fireEvent.click(within(row).getByTitle('More'))
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
    expect(screen.getByText('Drop chats here from the ⋯ menu')).toBeInTheDocument()
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

  it('creates a new group via the footer control and enters rename mode for it', async () => {
    // The footer "＋ New group" creates a group, then puts it into inline-rename
    // mode. The new group must exist in `groups` for its header (and editor) to
    // render, so we seed it with the id onCreateGroup resolves to.
    const onCreateGroup = vi.fn().mockResolvedValue('g-new')
    const props = baseProps({
      onCreateGroup,
      groups: [{ id: 'g-new', name: 'New group' }]
    })
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByText('＋ New group'))
    expect(onCreateGroup).toHaveBeenCalledOnce()

    // After the create resolves, the new group's header shows an inline editor.
    const editor = (await screen.findByDisplayValue('New group')) as HTMLInputElement
    expect(editor).toHaveClass('inline-edit')
    // The static group name is no longer rendered as a plain label.
    expect(screen.queryByText('New group')).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByText('⤓ Export'))
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
    fireEvent.click(screen.getByText('⤓ Export as HTML'))
    expect(props.onExportHtml).toHaveBeenCalledWith('a')
    // Plain "⤓ Export" stays distinct and was not invoked.
    expect(props.onExport).not.toHaveBeenCalled()
  })

  it('the footer Import control fires onImport', () => {
    const props = baseProps()
    render(<Sidebar {...props} />)

    fireEvent.click(screen.getByText('⤒ Import chat'))
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
    // The "Move to" list renders a button per group ("○ Work" when not in it).
    fireEvent.click(screen.getByRole('button', { name: '○ Work' }))
    expect(props.onMove).toHaveBeenCalledWith('a', 'g1')
  })

  it('“Remove from group” on a grouped conv fires onMove with null', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha', groupId: 'g1' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    fireEvent.click(screen.getByText('⤴ Remove from group'))
    expect(props.onMove).toHaveBeenCalledWith('a', null)
  })

  it('“Remove from group” is hidden for an ungrouped conv', () => {
    const props = baseProps({
      groups: [{ id: 'g1', name: 'Work' }],
      conversations: [makeConv({ id: 'a', title: 'Alpha' })]
    })
    render(<Sidebar {...props} />)

    openConvMenu('Alpha')
    expect(screen.queryByText('⤴ Remove from group')).not.toBeInTheDocument()
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
