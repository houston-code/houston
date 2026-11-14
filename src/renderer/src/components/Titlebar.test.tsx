import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Titlebar } from './Titlebar'

describe('Titlebar preview button', () => {
  it('toggles the preview panel and reflects the open state', () => {
    const onTogglePreview = vi.fn()
    render(<Titlebar title="Houston" onTogglePreview={onTogglePreview} previewOpen={true} />)
    const btn = screen.getByRole('button', { name: /preview/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(btn)
    expect(onTogglePreview).toHaveBeenCalledTimes(1)
  })

  it('shows a count badge only when servers are running', () => {
    const { rerender } = render(
      <Titlebar title="Houston" onTogglePreview={vi.fn()} previewCount={0} />
    )
    expect(screen.queryByText('2')).not.toBeInTheDocument()
    rerender(<Titlebar title="Houston" onTogglePreview={vi.fn()} previewCount={2} />)
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('omits the preview button when no handler is given', () => {
    render(<Titlebar title="Houston" />)
    expect(screen.queryByRole('button', { name: /preview/i })).not.toBeInTheDocument()
  })
})

describe('Titlebar commands and shortcuts buttons', () => {
  it('shows a labeled Commands button with its shortcut, and opens the palette', () => {
    const onOpenPalette = vi.fn()
    render(<Titlebar title="Houston" onOpenPalette={onOpenPalette} paletteShortcut="⌘K" />)
    const btn = screen.getByRole('button', { name: /^Commands/ })
    expect(btn).toHaveTextContent('Commands⌘K')
    expect(btn).toHaveAttribute('aria-keyshortcuts', 'Meta+K')
    fireEvent.click(btn)
    expect(onOpenPalette).toHaveBeenCalledTimes(1)
  })

  it('writes a Ctrl chord the way aria-keyshortcuts expects', () => {
    render(<Titlebar title="Houston" onOpenPalette={vi.fn()} paletteShortcut="Ctrl+K" />)
    expect(screen.getByRole('button', { name: /^Commands/ })).toHaveAttribute('aria-keyshortcuts', 'Control+K')
  })

  it('leaves the shortcut off when the palette has none bound', () => {
    render(<Titlebar title="Houston" onOpenPalette={vi.fn()} />)
    const btn = screen.getByRole('button', { name: 'Commands' })
    expect(btn).not.toHaveAttribute('aria-keyshortcuts')
  })

  it('opens the keyboard-shortcut sheet from the ? button', () => {
    const onShowShortcuts = vi.fn()
    render(<Titlebar title="Houston" onShowShortcuts={onShowShortcuts} shortcutsShortcut="⌘/" />)
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard shortcuts' }))
    expect(onShowShortcuts).toHaveBeenCalledTimes(1)
  })

  it('shows neither button without handlers', () => {
    render(<Titlebar title="Houston" />)
    expect(screen.queryByRole('button', { name: /Commands/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Keyboard shortcuts' })).toBeNull()
  })
})

describe('Titlebar icon-only actions', () => {
  it('labels each action for screen readers and shows a descriptive tooltip on hover', () => {
    render(
      <Titlebar
        title="Houston"
        onTogglePreview={vi.fn()}
        onShowFiles={vi.fn()}
        onShowChanges={vi.fn()}
        onToggleTerminal={vi.fn()}
      />
    )
    // Buttons render icon-only: the accessible name comes from aria-label, while a
    // shared custom tooltip (role="tooltip") appears on hover — no native `title`,
    // which is slow and can't be styled or made instant between buttons.
    for (const [name, tip] of [
      ['Preview', /toggle the live preview panel/i],
      ['Files', /browse the project's files/i],
      ['Changes', /uncommitted/i],
      ['Terminal', /integrated terminal/i]
    ] as const) {
      const btn = screen.getByRole('button', { name })
      // No visible text label — the button holds only its inline SVG icon.
      expect(btn.textContent).toBe('')
      expect(btn).not.toHaveAttribute('title')
      fireEvent.mouseEnter(btn)
      expect(screen.getByRole('tooltip')).toHaveTextContent(tip)
      fireEvent.mouseLeave(btn)
    }
  })

  it('shows the changed-file count as a badge and folds +/− into the tooltip', () => {
    render(
      <Titlebar
        title="Houston"
        onShowChanges={vi.fn()}
        changes={{ fileCount: 3, added: 12, removed: 4 }}
      />
    )
    // The badge's count is part of the button's name, not left to the picture.
    const btn = screen.getByRole('button', { name: 'Changes, 3 files' })
    expect(within(btn).getByText('3')).toBeInTheDocument()
    fireEvent.mouseEnter(btn)
    expect(screen.getByRole('tooltip')).toHaveTextContent('+12 −4')
    // Dirty state is signalled by the badge alone — no accent outline (that's
    // reserved for open docked panels like Preview and Terminal).
    expect(btn.className).toBe('titlebar__action')
  })

  it('outlines Files and Changes while their panel is open, like the other panel toggles', () => {
    render(
      <Titlebar title="Houston" onShowFiles={vi.fn()} filesOpen={true} onShowChanges={vi.fn()} changesOpen={false} />
    )
    expect(screen.getByRole('button', { name: 'Files' })).toHaveClass('titlebar__action--active')
    expect(screen.getByRole('button', { name: 'Changes' })).not.toHaveClass('titlebar__action--active')
  })

  it('names the running preview servers in the Preview button', () => {
    render(<Titlebar title="Houston" onTogglePreview={vi.fn()} previewCount={2} />)
    expect(screen.getByRole('button', { name: 'Preview, 2 servers running' })).toBeInTheDocument()
  })

  it('omits the changes badge when the working tree is clean', () => {
    render(
      <Titlebar
        title="Houston"
        onShowChanges={vi.fn()}
        changes={{ fileCount: 0, added: 0, removed: 0 }}
      />
    )
    const btn = screen.getByRole('button', { name: 'Changes' })
    expect(within(btn).queryByText(/^\d+$/)).not.toBeInTheDocument()
  })
})

describe('Titlebar side chat button', () => {
  it('toggles the side chat and reflects the open state', () => {
    const onToggleSideChat = vi.fn()
    render(<Titlebar title="Houston" onToggleSideChat={onToggleSideChat} sideChatOpen={false} />)
    const btn = screen.getByRole('button', { name: 'Side chat' })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(btn)
    expect(onToggleSideChat).toHaveBeenCalledTimes(1)
  })

  it('is absent with no open chat', () => {
    render(<Titlebar title="Houston" />)
    expect(screen.queryByRole('button', { name: 'Side chat' })).toBeNull()
  })
})

describe('Titlebar needs-you pill', () => {
  it('shows how many other chats wait on the user and opens the next', () => {
    const onNext = vi.fn()
    const { rerender } = render(<Titlebar title="Houston" needsYou={{ count: 2, onNext }} />)
    fireEvent.click(screen.getByRole('button', { name: /2 need you/ }))
    expect(onNext).toHaveBeenCalled()
    rerender(<Titlebar title="Houston" needsYou={{ count: 1, onNext }} />)
    expect(screen.getByRole('button', { name: /1 needs you/ })).toBeInTheDocument()
  })

  it('hides at zero', () => {
    render(<Titlebar title="Houston" needsYou={{ count: 0, onNext: vi.fn() }} />)
    expect(screen.queryByRole('button', { name: /need/ })).not.toBeInTheDocument()
  })
})

describe('Titlebar title', () => {
  it('shows the whole title on hover, since a long one is cut short', () => {
    const long = 'Investigate why the background dev server keeps restarting after every save'
    render(<Titlebar title={long} />)
    expect(screen.getByText(long)).toHaveAttribute('title', long)
  })

  it('leaves the drag region only when cut short, so a title that fits still moves the window', () => {
    const widths = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    const { rerender } = render(<Titlebar title="Short" />)
    expect(screen.getByText('Short')).not.toHaveClass('titlebar__title--cut')
    widths.mockReturnValue(400)
    rerender(<Titlebar title="A much longer title" />)
    expect(screen.getByText('A much longer title')).toHaveClass('titlebar__title--cut')
    vi.restoreAllMocks()
  })
})

describe('Titlebar shortcuts in tooltips', () => {
  it('names the shortcut in the tooltip and aria-keyshortcuts of every action that has one', () => {
    render(
      <Titlebar
        title="Houston"
        onToggleTerminal={vi.fn()}
        terminalShortcut="⌃`"
        onShowShortcuts={vi.fn()}
        shortcutsShortcut="⌘/"
      />
    )
    const terminal = screen.getByRole('button', { name: 'Terminal' })
    expect(terminal).toHaveAttribute('aria-keyshortcuts', 'Control+`')
    fireEvent.mouseEnter(terminal)
    expect(screen.getByRole('tooltip')).toHaveTextContent('(⌃`)')
    fireEvent.mouseLeave(terminal)
    const help = screen.getByRole('button', { name: 'Keyboard shortcuts' })
    expect(help).toHaveAttribute('aria-keyshortcuts', 'Meta+/')
    fireEvent.mouseEnter(help)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Keyboard shortcuts (⌘/)')
  })

  it('advertises no shortcut when none is bound', () => {
    render(<Titlebar title="Houston" onToggleTerminal={vi.fn()} onShowShortcuts={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Terminal' })).not.toHaveAttribute('aria-keyshortcuts')
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).not.toHaveAttribute('aria-keyshortcuts')
  })
})
