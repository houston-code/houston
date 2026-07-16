import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { PlanPayload } from '@shared/agent'
import { PlanPanel } from './PlanPanel'

const plan: PlanPayload = {
  title: 'Persist the composer draft',
  body: '## Overview\n\nKeep an unsent message per chat.\n\n1. Add a `draft` field\n2. Restore it on open',
  files: ['src/main/conversations.ts', 'src/renderer/src/hooks/useChat.ts']
}

/** An older, pre-`body` plan that still uses the structured overview + steps. */
const legacyPlan: PlanPayload = {
  title: 'Legacy plan',
  overview: 'A summary.',
  steps: ['First step', 'Second step'],
  files: ['a.ts']
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
  it('renders the title, the full freeform body as markdown, and file chips', () => {
    const { panel } = renderPanel()
    expect(screen.getByRole('heading', { name: 'Persist the composer draft' })).toBeTruthy()
    // The whole `body` markdown is rendered — heading, paragraph, and list items.
    expect(panel.querySelector('.plan-panel__markdown')).toBeTruthy()
    expect(screen.getByText('Keep an unsent message per chat.')).toBeTruthy()
    expect(screen.getByText('Restore it on open')).toBeTruthy()
    expect(screen.getByText('src/main/conversations.ts')).toBeTruthy()
    // A freeform plan reports only the file count (no structured step count).
    expect(screen.getByText(/touches 2 files/)).toBeTruthy()
    expect(screen.queryByText(/step/)).toBeNull()
  })

  it('keeps the whole plan in one scroll region, with the body before a collapsed files list', () => {
    const { panel } = renderPanel()
    const body = panel.querySelector('.plan-panel__body') as HTMLElement
    // The plan body and the files both live inside the single scrolling body — so a
    // long file list can't starve the plan (the bug this layout fixes).
    const markdown = body.querySelector('.plan-panel__markdown')
    const files = body.querySelector('details.plan-panel__files')
    expect(markdown).toBeTruthy()
    expect(files).toBeTruthy()
    // Files are collapsed by default (the plan stays front-and-center) and ordered last.
    expect((files as HTMLDetailsElement).open).toBe(false)
    expect(markdown!.compareDocumentPosition(files!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // The count is surfaced on the summary so the list reads as collapsible.
    expect(screen.getByText('2', { selector: '.plan-panel__files-count' })).toBeTruthy()
  })

  it('falls back to structured overview + steps for an older plan without a body', () => {
    const { panel } = renderPanel({ plan: legacyPlan })
    expect(panel.querySelector('.plan-panel__markdown')).toBeNull()
    expect(panel.querySelector('.plan-panel__steps')).toBeTruthy()
    expect(screen.getByText('First step')).toBeTruthy()
    expect(screen.getByText('Second step')).toBeTruthy()
    // Legacy plans still show the step count.
    expect(screen.getByText(/2 steps · touches 1 file/)).toBeTruthy()
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

  describe('manual editing', () => {
    it('opens the markdown editor from the Edit button (and via the E key)', () => {
      const { panel } = renderPanel()
      expect(screen.queryByLabelText('Edit the plan (markdown)')).toBeNull()
      fireEvent.keyDown(panel, { key: 'e' })
      expect(screen.getByLabelText('Edit the plan (markdown)')).toBeTruthy()
    })

    it('accepts the hand-edited plan verbatim (editedBody) after Done', () => {
      const { onResolve } = renderPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Edit the plan' }))
      fireEvent.change(screen.getByLabelText('Edit the plan (markdown)'), {
        target: { value: '## New plan\n\nDo it differently.' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      // The edit is reflected: badge + relabelled accept button.
      expect(screen.getByText('Edited')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: /Accept edited plan/ }))
      expect(onResolve).toHaveBeenCalledWith({
        kind: 'accept',
        mode: 'auto-edit',
        editedBody: '## New plan\n\nDo it differently.'
      })
    })

    it('discards the edit on Cancel and accepts without editedBody', () => {
      const { onResolve } = renderPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Edit the plan' }))
      fireEvent.change(screen.getByLabelText('Edit the plan (markdown)'), { target: { value: 'throwaway' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByText('Edited')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Accept & run/ }))
      expect(onResolve).toHaveBeenCalledWith({ kind: 'accept', mode: 'auto-edit' })
    })

    it('treats an edit back to the original as not edited', () => {
      const { onResolve } = renderPanel()
      fireEvent.click(screen.getByRole('button', { name: 'Edit the plan' }))
      // Change then restore the exact original body.
      const editor = screen.getByLabelText('Edit the plan (markdown)')
      fireEvent.change(editor, { target: { value: 'temp' } })
      fireEvent.change(editor, { target: { value: plan.body } })
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.queryByText('Edited')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: /Accept & run/ }))
      expect(onResolve).toHaveBeenCalledWith({ kind: 'accept', mode: 'auto-edit' })
    })

    it('does not offer editing for a legacy (steps-based) plan', () => {
      renderPanel({ plan: legacyPlan })
      expect(screen.queryByRole('button', { name: 'Edit the plan' })).toBeNull()
    })

    it('discards a prior plan hand-edit when a revised plan arrives (no stale editedBody)', () => {
      // The panel is NOT remounted across a "suggest changes" revision, so its edit
      // state must reset when the plan prop changes — otherwise the stale edit renders
      // and, on accept, is submitted over the agent's new plan.
      const revised: PlanPayload = {
        title: 'Revised plan',
        body: '## Revised\n\nThe agent reworked it.',
        files: ['b.ts']
      }
      const { onResolve, rerender } = renderPanel()
      // Hand-edit the first plan.
      fireEvent.click(screen.getByRole('button', { name: 'Edit the plan' }))
      fireEvent.change(screen.getByLabelText('Edit the plan (markdown)'), {
        target: { value: 'STALE EDIT of plan A' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
      expect(screen.getByText('Edited')).toBeTruthy()

      // A revised plan is presented into the SAME panel instance (no remount).
      rerender(
        <PlanPanel
          plan={revised}
          revising={false}
          onResolve={onResolve}
          onClose={vi.fn()}
          onResizeMouseDown={vi.fn()}
        />
      )
      // The stale edit and its "Edited" badge are gone; the new plan's body shows.
      expect(screen.queryByText('Edited')).toBeNull()
      expect(screen.getByText('The agent reworked it.')).toBeTruthy()
      expect(screen.queryByText('STALE EDIT of plan A')).toBeNull()
      // Accepting submits the new plan (no editedBody), not the discarded edit.
      fireEvent.click(screen.getByRole('button', { name: /Accept & run/ }))
      expect(onResolve).toHaveBeenCalledWith({ kind: 'accept', mode: 'auto-edit' })
    })
  })
})
