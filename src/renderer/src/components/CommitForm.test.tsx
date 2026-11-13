import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommitForm } from './CommitForm'

let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => {
  api = {
    gitBranchSync: vi.fn().mockResolvedValue({ branch: 'feat', upstream: 'origin/feat', ahead: 0, remote: 'origin' }),
    gitSuggestMessage: vi.fn().mockResolvedValue({ ok: true, detail: 'Add the thing' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, detail: 'abc1234' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, detail: 'origin/feat' })
  }
  window.api = api as unknown as typeof window.api
})

describe('CommitForm', () => {
  it('suggests a message, commits it, and reloads the view', async () => {
    const onChanged = vi.fn()
    render(<CommitForm workspace="/ws" conversationId="c1" hasChanges onChanged={onChanged} />)
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Suggest message' }))
    await waitFor(() => expect(screen.getByLabelText('Commit message')).toHaveValue('Add the thing'))
    expect(api.gitSuggestMessage).toHaveBeenCalledWith('/ws', 'c1')
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(await screen.findByText('Committed abc1234.')).toBeInTheDocument()
    expect(api.gitCommit).toHaveBeenCalledWith('/ws', 'Add the thing')
    expect(onChanged).toHaveBeenCalled()
    expect(screen.getByLabelText('Commit message')).toHaveValue('')
  })

  it('commits with Cmd+Enter and shows git’s error', async () => {
    api.gitCommit.mockResolvedValue({ ok: false, error: 'Author identity unknown' })
    render(<CommitForm workspace="/ws" hasChanges onChanged={vi.fn()} />)
    const box = screen.getByLabelText('Commit message')
    fireEvent.change(box, { target: { value: 'Fix' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(await screen.findByText('Author identity unknown')).toBeInTheDocument()
  })

  it('offers Push for commits not yet on the upstream, and Publish branch for a first push', async () => {
    api.gitBranchSync.mockResolvedValue({ branch: 'feat', upstream: 'origin/feat', ahead: 2, remote: 'origin' })
    const { unmount } = render(<CommitForm workspace="/ws" hasChanges={false} onChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Push 2 commits' }))
    expect(await screen.findByText('Pushed to origin/feat.')).toBeInTheDocument()
    unmount()
    api.gitBranchSync.mockResolvedValue({ branch: 'feat', upstream: null, ahead: 1, remote: 'origin' })
    render(<CommitForm workspace="/ws" hasChanges onChanged={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Publish branch' })).toHaveAttribute(
      'title',
      'Push feat to origin for the first time'
    )
  })

  it('shows nothing with no changes and nothing to push, and holds actions while a run is busy', async () => {
    const { container, unmount } = render(<CommitForm workspace="/ws" hasChanges={false} onChanged={vi.fn()} />)
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    unmount()
    render(<CommitForm workspace="/ws" hasChanges busy onChanged={vi.fn()} />)
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Commit' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Suggest message' })).toBeDisabled()
  })
})
