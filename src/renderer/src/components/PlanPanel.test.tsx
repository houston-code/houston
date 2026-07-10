import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { PlanPayload } from '@shared/agent'
import { PlanPanel } from './PlanPanel'

const plan: PlanPayload = {
  title: 'Persist the composer draft',
  overview: 'Keep an unsent message per chat.',
  steps: ['Add a `draft` field', 'Restore it on open'],
  files: ['src/main/conversations.ts', 'src/renderer/src/hooks/useChat.ts']
}

function renderPanel(props: Partial<React.ComponentProps<typeof PlanPanel>> = {}) {
  const onResolve = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    <PlanPanel
      plan={plan}
      revising={false}
      onResolve={onResolve}
      onClose={onClose}
      onResizeMouseDown={vi.fn()}
      {...props}
    />
  )
  const panel = utils.container.querySelector('.plan-panel') as HTMLElement
  return { onResolve, onClose, panel, ...utils }
}

describe('PlanPanel', () => {
  it('renders the title, steps, and file chips', () => {
    renderPanel()
    expect(screen.getByRole('heading', { name: 'Persist the composer draft' })).toBeTruthy()
    expect(screen.getByText('Restore it on open')).toBeTruthy()
    expect(screen.getByText('src/main/conversations.ts')).toBeTruthy()
    // "2 steps · touches 2 files"
    expect(screen.getByText(/2 steps · touches 2 files/)).toBeTruthy()
  })

  it('keeps the whole plan in one scroll region, with steps before a collapsed files list', () => {
    const { panel } = renderPanel()
    const body = panel.querySelector('.plan-panel__body') as HTMLElement
    // The steps and the files both live inside the single scrolling body — so a long
    // file list can't starve the steps (the bug this layout fixes).
    const steps = body.querySelector('.plan-panel__steps')
    const files = body.querySelector('details.plan-panel__files')
    expect(steps).toBeTruthy()
    expect(files).toBeTruthy()
    // Files are collapsed by default (steps stay front-and-center) and ordered last.
    expect((files as HTMLDetailsElement).open).toBe(false)
    expect(steps!.compareDocumentPosition(files!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The count is surfaced on the summary so the list reads as collapsible.
    expect(screen.getByText('2', { selector: '.plan-panel__files-count' })).toBeTruthy()
  })

  it('accepts with auto-edit by default', () => {
    const { onResolve } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Accept & run/ }))
    expect(onResolve).toHaveBeenCalledWith({ kind: 'accept', mode: 'auto-edit' })
  })

  it('accepts with "ask" after choosing Ask each', () => {
    const { onResolve } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Ask each' }))
    fireEvent.click(screen.getByRole('button', { name: /Accept & run/ }))
    expect(onResolve).toHaveBeenCalledWith({ kind: 'accept', mode: 'ask' })
  })

  it('rejects when Reject is clicked', () => {
    const { onResolve } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Reject plan/ }))
    expect(onResolve).toHaveBeenCalledWith({ kind: 'reject' })
  })

  it('sends a suggestion with the typed note', () => {
    const { onResolve } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Suggest changes/ }))
    const box = screen.getByLabelText('Suggested changes to the plan')
    fireEvent.change(box, { target: { value: 'Debounce at 250ms.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    expect(onResolve).toHaveBeenCalledWith({ kind: 'suggest', note: 'Debounce at 250ms.' })
  })

  it('does not send an empty suggestion', () => {
    const { onResolve } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Suggest changes/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }))
    expect(onResolve).not.toHaveBeenCalled()
  })

  it('dismisses via the close button', () => {
    const { onClose } = renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss plan panel' }))
    expect(onClose).toHaveBeenCalled()
  })

  describe('keyboard shortcuts', () => {
    it('A accepts, R rejects, S opens the suggestion box', () => {
      const { onResolve, panel } = renderPanel()
      fireEvent.keyDown(panel, { key: 'a' })
      expect(onResolve).toHaveBeenCalledWith({ kind: 'accept', mode: 'auto-edit' })

      onResolve.mockClear()
      fireEvent.keyDown(panel, { key: 'r' })
      expect(onResolve).toHaveBeenCalledWith({ kind: 'reject' })

      fireEvent.keyDown(panel, { key: 's' })
      expect(screen.getByLabelText('Suggested changes to the plan')).toBeTruthy()
    })

    it('ignores shortcuts while typing in the suggestion box', () => {
      const { onResolve } = renderPanel()
      fireEvent.click(screen.getByRole('button', { name: /Suggest changes/ }))
      const box = screen.getByLabelText('Suggested changes to the plan')
      // 'a' typed into the note must not trigger accept.
      fireEvent.keyDown(box, { key: 'a' })
      expect(onResolve).not.toHaveBeenCalled()
    })

    it('ignores shortcuts when a modifier is held', () => {
      const { onResolve, panel } = renderPanel()
      fireEvent.keyDown(panel, { key: 'a', metaKey: true })
      expect(onResolve).not.toHaveBeenCalled()
    })
  })

  it('shows a working state and hides the actions while revising', () => {
    renderPanel({ revising: true })
    expect(screen.getByText(/Revising the plan/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Accept & run/ })).toBeNull()
  })
})
