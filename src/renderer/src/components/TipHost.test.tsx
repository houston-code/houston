import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TIP_IDS, type TipId } from '@shared/onboarding'
import { TipHost } from './TipHost'

/** Put anchor elements for the given tips on the page, as the real controls would. */
function anchors(ids: TipId[]): () => void {
  const els = ids.map((id) => {
    const el = document.createElement('button')
    el.dataset.tour = id
    document.body.appendChild(el)
    return el
  })
  return () => els.forEach((el) => el.remove())
}

function props(over: Partial<Parameters<typeof TipHost>[0]> = {}) {
  return {
    relevant: ['approval', 'worktree'] as TipId[],
    seen: [] as string[],
    suppressed: false,
    touring: false,
    onSeen: vi.fn(),
    onTourEnd: vi.fn(),
    ...over
  }
}

let cleanupAnchors: () => void = () => {}
afterEach(() => cleanupAnchors())

describe('TipHost', () => {
  it('shows the first relevant tip, highlights its control, and counts the run', () => {
    cleanupAnchors = anchors(['approval', 'worktree'])
    render(<TipHost {...props()} />)
    expect(screen.getByRole('dialog', { name: 'You stay in control' })).toBeInTheDocument()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(document.querySelector('[data-tour="approval"]')).toHaveClass('tour-anchor')
  })

  it('marks a tip seen on Next and advances the counter', () => {
    cleanupAnchors = anchors(['approval', 'worktree'])
    const p = props()
    const { rerender } = render(<TipHost {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(p.onSeen).toHaveBeenCalledWith(['approval'])
    // The parent persists the seen id and re-renders with it.
    rerender(<TipHost {...p} seen={['approval']} />)
    expect(screen.getByRole('dialog', { name: 'Keep your checkout clean' })).toBeInTheDocument()
    expect(screen.getByText('2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument()
    expect(document.querySelector('[data-tour="approval"]')).not.toHaveClass('tour-anchor')
  })

  it('skips a tip whose control is not rendered', () => {
    cleanupAnchors = anchors(['approval'])
    render(<TipHost {...props()} />)
    expect(screen.getByRole('dialog', { name: 'You stay in control' })).toBeInTheDocument()
    expect(screen.queryByText(/of 2/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument()
  })

  it('picks up an anchor that mounts later', async () => {
    render(<TipHost {...props({ relevant: ['worktree'] })} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => {
      cleanupAnchors = anchors(['worktree'])
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.getByRole('dialog', { name: 'Keep your checkout clean' })).toBeInTheDocument()
  })

  it('holds tips while a modal is open', () => {
    cleanupAnchors = anchors(['approval'])
    render(<TipHost {...props({ suppressed: true })} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows nothing once every relevant tip is seen', () => {
    cleanupAnchors = anchors(['approval', 'worktree'])
    render(<TipHost {...props({ seen: ['approval', 'worktree'] })} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('Skip tips marks every tip seen and ends the tour', () => {
    cleanupAnchors = anchors(['approval'])
    const p = props()
    render(<TipHost {...p} />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip tips' }))
    expect(p.onSeen).toHaveBeenCalledWith(TIP_IDS)
    expect(p.onTourEnd).toHaveBeenCalled()
  })

  it('Escape dismisses the tip without reaching the app-wide Escape handler', () => {
    cleanupAnchors = anchors(['approval'])
    const p = props()
    render(<TipHost {...p} />)
    const appEscape = vi.fn((e: KeyboardEvent) => e.defaultPrevented)
    window.addEventListener('keydown', appEscape)
    fireEvent.keyDown(window, { key: 'Escape' })
    window.removeEventListener('keydown', appEscape)
    expect(p.onSeen).toHaveBeenCalledWith(['approval'])
    expect(appEscape).toHaveReturnedWith(true)
  })

  it('focuses the tip during a requested tour, and ends the tour when nothing is left', () => {
    cleanupAnchors = anchors(['approval'])
    const p = props({ relevant: [...TIP_IDS], touring: true })
    const { rerender } = render(<TipHost {...p} />)
    expect(screen.getByRole('button', { name: 'Got it' })).toHaveFocus()
    rerender(<TipHost {...p} seen={['approval']} />)
    expect(p.onTourEnd).toHaveBeenCalled()
  })

  it('stays passive (no focus steal) for contextual tips', () => {
    cleanupAnchors = anchors(['approval'])
    render(<TipHost {...props()} />)
    expect(screen.getByRole('button', { name: 'Got it' })).not.toHaveFocus()
  })
})

describe('TipHost Escape scoping', () => {
  it('leaves Escape alone while focus is in another control (find bar, composer)', () => {
    cleanupAnchors = anchors(['approval'])
    const input = document.createElement('input')
    document.body.appendChild(input)
    const p = props()
    render(<TipHost {...p} />)
    input.focus()
    const other = vi.fn((e: KeyboardEvent) => e.defaultPrevented)
    window.addEventListener('keydown', other)
    fireEvent.keyDown(input, { key: 'Escape' })
    window.removeEventListener('keydown', other)
    input.remove()
    expect(p.onSeen).not.toHaveBeenCalled()
    expect(other).toHaveReturnedWith(false)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('stops watching the DOM once every relevant tip is seen', () => {
    const observe = vi.spyOn(MutationObserver.prototype, 'observe')
    render(<TipHost {...props({ seen: ['approval', 'worktree'] })} />)
    expect(observe).not.toHaveBeenCalled()
    observe.mockRestore()
  })
})

describe('message-box tips', () => {
  it('both point at the message box (data-tour="composer")', () => {
    const el = document.createElement('textarea')
    el.dataset.tour = 'composer'
    document.body.appendChild(el)
    render(<TipHost {...props({ relevant: ['context', 'steer'] })} />)
    expect(screen.getByRole('dialog', { name: 'Quick additional context' })).toBeInTheDocument()
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
    expect(el).toHaveClass('tour-anchor')
    el.remove()
  })
})
