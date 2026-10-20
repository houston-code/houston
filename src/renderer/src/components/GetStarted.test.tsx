import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChecklistFacts } from '@shared/onboarding'
import { GetStarted } from './GetStarted'

function setup(facts: Partial<ChecklistFacts> = {}, modelSummary?: string, folderSummary?: string) {
  const props = {
    facts: { modelReady: false, hasWorkspace: false, hasConversation: false, ...facts },
    modelSummary,
    folderSummary,
    onConnectModel: vi.fn(),
    onChooseFolder: vi.fn(),
    onSkip: vi.fn()
  }
  render(<GetStarted {...props} />)
  return props
}

describe('GetStarted', () => {
  it('starts at step 1 with Connect as the action', () => {
    const p = setup()
    expect(screen.getByText('0 of 3')).toBeInTheDocument()
    const current = screen.getByText('Connect a model').closest('li')!
    expect(current).toHaveAttribute('aria-current', 'step')
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    expect(p.onConnectModel).toHaveBeenCalledTimes(1)
  })

  it('ticks off a connected model and moves on to the folder step', () => {
    const p = setup({ modelReady: true })
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect' })).not.toBeInTheDocument()
    expect(screen.getByText('(done)')).toBeInTheDocument()
    expect(screen.getByText('Open a project folder').closest('li')).toHaveAttribute(
      'aria-current',
      'step'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    expect(p.onChooseFolder).toHaveBeenCalledTimes(1)
  })

  it('leaves only the first-task hint once model and folder are ready', () => {
    setup({ modelReady: true, hasWorkspace: true })
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    expect(screen.getByText('Send your first task').closest('li')).toHaveAttribute(
      'aria-current',
      'step'
    )
    // The last step is done from the composer, so it has no button of its own.
    expect(screen.queryByRole('button', { name: /Connect|Choose folder/ })).not.toBeInTheDocument()
  })

  it('can be skipped', () => {
    const p = setup()
    fireEvent.click(screen.getByRole('button', { name: 'Skip setup' }))
    expect(p.onSkip).toHaveBeenCalledTimes(1)
  })

  it('lets a finished step 1 be changed, showing what it connected', () => {
    const p = setup({ modelReady: true }, 'Anthropic · Claude Sonnet 5.5')
    expect(screen.getByText('Anthropic · Claude Sonnet 5.5')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
    expect(p.onConnectModel).toHaveBeenCalledTimes(1)
  })

  it('offers Change only on finished steps', () => {
    setup()
    expect(screen.queryByRole('button', { name: /^Change/ })).not.toBeInTheDocument()
  })

  it('lets a finished step 2 be changed too, showing the folder', () => {
    const p = setup({ modelReady: true, hasWorkspace: true }, 'OpenAI · GPT 6.1 Sol', 'my-app')
    expect(screen.getByText('my-app')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change model' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change folder' }))
    expect(p.onChooseFolder).toHaveBeenCalledTimes(1)
  })

  it('a folder opened before a model still shows its Change while step 1 waits', () => {
    const p = setup({ hasWorkspace: true }, undefined, 'my-app')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change folder' }))
    expect(p.onChooseFolder).toHaveBeenCalledTimes(1)
  })
})
