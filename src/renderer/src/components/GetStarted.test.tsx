import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChecklistFacts } from '@shared/onboarding'
import { GetStarted } from './GetStarted'

function setup(
  facts: Partial<ChecklistFacts> = {},
  modelSummary?: string,
  folderSummary?: string,
  focusModelStep?: boolean
) {
  const props = {
    focusModelStep,
    facts: { modelReady: false, hasWorkspace: false, hasConversation: false, ...facts },
    modelSummary,
    folderSummary,
    onConnectModel: vi.fn(),
    onChooseFolder: vi.fn()
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

  it('offers recent folders under the open folder step', () => {
    const onOpenFolder = vi.fn()
    render(
      <GetStarted
        facts={{ modelReady: true, hasWorkspace: false, hasConversation: false }}
        onConnectModel={vi.fn()}
        onChooseFolder={vi.fn()}
        recentFolders={[{ path: '/home/me/app', name: 'app', where: '…/home/me/app' }]}
        onOpenFolder={onOpenFolder}
      />
    )
    const recents = screen.getByRole('navigation', { name: 'Or reopen' })
    expect(recents.closest('li')).toHaveTextContent('Open a project folder')
    fireEvent.click(screen.getByRole('button', { name: 'Open app (…/home/me/app)' }))
    expect(onOpenFolder).toHaveBeenCalledWith('/home/me/app')
  })

  it('hides recent folders once a folder is open', () => {
    render(
      <GetStarted
        facts={{ modelReady: true, hasWorkspace: true, hasConversation: false }}
        onConnectModel={vi.fn()}
        onChooseFolder={vi.fn()}
        recentFolders={[{ path: '/home/me/app', name: 'app', where: '…/home/me/app' }]}
        onOpenFolder={vi.fn()}
      />
    )
    expect(screen.queryByRole('navigation', { name: 'Or reopen' })).not.toBeInTheDocument()
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

  it('has no way to skip setup: sending the first task is what finishes it', () => {
    setup()
    expect(screen.queryByRole('button', { name: /Skip/ })).not.toBeInTheDocument()
  })

  it('tells step 3 where to act, with an example suited to the folder', () => {
    render(
      <GetStarted
        facts={{ modelReady: true, hasWorkspace: true, hasConversation: false }}
        taskExample="Build a simple to-do list web page in this folder."
        onConnectModel={vi.fn()}
        onChooseFolder={vi.fn()}
      />
    )
    expect(
      screen.getByText(/Type it in the message box below and press ↵\. For example: .Build a simple to-do list web page in this folder\../)
    ).toBeInTheDocument()
  })

  it('puts the example in the message box when clicked, while step 3 is current', () => {
    const onUseExample = vi.fn()
    const { rerender } = render(
      <GetStarted
        facts={{ modelReady: true, hasWorkspace: true, hasConversation: false }}
        taskExample="Explain how this project is organized."
        onUseExample={onUseExample}
        onConnectModel={vi.fn()}
        onChooseFolder={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Explain how this project is organized/ }))
    expect(onUseExample).toHaveBeenCalledWith('Explain how this project is organized.')
    // Before a folder is open, step 3 is not current yet: the example is plain text.
    rerender(
      <GetStarted
        facts={{ modelReady: true, hasWorkspace: false, hasConversation: false }}
        taskExample="Explain how this project is organized."
        onUseExample={onUseExample}
        onConnectModel={vi.fn()}
        onChooseFolder={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: /Explain how this project/ })).toBeNull()
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

  it('returns focus to step 1 after backing out of the Connect panel', () => {
    setup({}, undefined, undefined, true)
    expect(screen.getByRole('button', { name: 'Connect' })).toHaveFocus()
  })

  it('returns focus to step 1 Change once a model is connected', () => {
    setup({ modelReady: true }, 'Anthropic · Claude', undefined, true)
    expect(screen.getByRole('button', { name: 'Change model' })).toHaveFocus()
  })

  it('leaves focus alone on an ordinary mount', () => {
    setup()
    expect(document.body).toHaveFocus()
  })
})
