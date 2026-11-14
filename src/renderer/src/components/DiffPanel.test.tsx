import { act, render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkingTreeChanges } from '@shared/workingTree'
import { fileDiffSignature, type ChatChanges } from '@shared/changes'
import { DiffPanel, revertQuestion } from './DiffPanel'
import { clearAllDrafts } from '../lib/diffComments'

/** Install a fake `window.api` whose getWorkingTreeChanges resolves to `data`. */
function installApi(data: WorkingTreeChanges, chat: ChatChanges = { files: [], added: 0, removed: 0, unavailable: 0 }) {
  const getWorkingTreeChanges = vi.fn().mockResolvedValue(data)
  const getChatChanges = vi.fn().mockResolvedValue(chat)
  const initGitRepo = vi.fn().mockResolvedValue({ ok: true })
  const revertChange = vi.fn().mockResolvedValue({ ok: true })
  const openWorkspacePath = vi.fn().mockResolvedValue({ ok: true })
  window.api = {
    getWorkingTreeChanges,
    getChatChanges,
    initGitRepo,
    revertChange,
    openWorkspacePath
  } as unknown as typeof window.api
  return { getWorkingTreeChanges, getChatChanges, initGitRepo, revertChange, openWorkspacePath }
}

const sampleChanges: WorkingTreeChanges = {
  isRepo: true,
  branch: 'feature/x',
  added: 3,
  removed: 1,
  files: [
    {
      path: 'src/foo.ts',
      status: 'modified',
      added: 1,
      removed: 1,
      binary: false,
      hunks: [
        {
          header: '@@ -1,2 +1,2 @@',
          lines: [
            { type: 'del', text: 'const b = 2' },
            { type: 'add', text: 'const b = 3' }
          ]
        }
      ]
    },
    {
      path: 'new.txt',
      status: 'untracked',
      added: 2,
      removed: 0,
      binary: false,
      hunks: [
        {
          header: '@@ -0,0 +1,2 @@',
          lines: [
            { type: 'add', text: 'hello' },
            { type: 'add', text: 'world' }
          ]
        }
      ]
    }
  ]
}

describe('DiffPanel', () => {
  beforeEach(() => {
    localStorage.clear()
    clearAllDrafts()
  })

  it('lists changed files with the working-tree scope label and totals', async () => {
    installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" />)

    expect(await screen.findByText('src/foo.ts')).toBeInTheDocument()
    expect(screen.getByText('new.txt')).toBeInTheDocument()
    // The label makes the scope explicit so users don't read it as session-only.
    expect(screen.getByText(/All uncommitted changes in the working tree/)).toBeInTheDocument()
    expect(screen.getByText(/on feature\/x/)).toBeInTheDocument()
  })

  it('shows an empty state when the tree is clean', async () => {
    installApi({ isRepo: true, branch: 'main', files: [], added: 0, removed: 0 })
    render(<DiffPanel workspace="/repo" />)
    expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument()
  })

  it('reports when the workspace is not a git repository', async () => {
    installApi({ isRepo: false, branch: null, files: [], added: 0, removed: 0 })
    render(<DiffPanel workspace="/tmp" />)
    expect(await screen.findByText(/isn’t a git repository/)).toBeInTheDocument()
  })

  it('explains a repository git cannot open, with git\'s reason and no init offer', async () => {
    installApi({
      isRepo: false,
      unreadable: 'not a git repository: (null)',
      branch: null,
      files: [],
      added: 0,
      removed: 0
    })
    render(<DiffPanel workspace="/repo/wt" />)
    expect(await screen.findByText(/in a git repository that git can’t open/)).toBeInTheDocument()
    expect(screen.getByText('not a git repository: (null)')).toBeInTheDocument()
    expect(screen.queryByText(/isn’t a git repository/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Initialize git repository/ })).not.toBeInTheDocument()
  })

  it('initializes a repo from the empty state, then reloads to show the files', async () => {
    const untracked: WorkingTreeChanges = {
      isRepo: true,
      branch: 'main',
      added: 1,
      removed: 0,
      files: [
        {
          path: 'app.ts',
          status: 'untracked',
          added: 1,
          removed: 0,
          binary: false,
          hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ type: 'add', text: 'export const x = 1' }] }]
        }
      ]
    }
    // First load: not a repo. After init succeeds, the reload shows the untracked file.
    const getWorkingTreeChanges = vi
      .fn()
      .mockResolvedValueOnce({ isRepo: false, branch: null, files: [], added: 0, removed: 0 })
      .mockResolvedValue(untracked)
    const initGitRepo = vi.fn().mockResolvedValue({ ok: true })
    window.api = { getWorkingTreeChanges, initGitRepo } as unknown as typeof window.api

    render(<DiffPanel workspace="/tmp/app" />)
    fireEvent.click(await screen.findByRole('button', { name: /Initialize git repository/ }))

    await waitFor(() => expect(initGitRepo).toHaveBeenCalledWith('/tmp/app'))
    expect(await screen.findByText('app.ts')).toBeInTheDocument()
  })

  it('surfaces an error when initializing the repo fails', async () => {
    const { initGitRepo } = installApi({
      isRepo: false,
      branch: null,
      files: [],
      added: 0,
      removed: 0
    })
    initGitRepo.mockResolvedValue({ ok: false, error: 'git init failed.' })

    render(<DiffPanel workspace="/tmp/app" />)
    fireEvent.click(await screen.findByRole('button', { name: /Initialize git repository/ }))
    expect(await screen.findByText('git init failed.')).toBeInTheDocument()
  })

  it('hands off to the agent when Create PR is clicked', async () => {
    installApi(sampleChanges)
    const onShip = vi.fn()
    render(<DiffPanel workspace="/repo" onShip={onShip} />)
    fireEvent.click(await screen.findByRole('button', { name: /Create PR/ }))
    expect(onShip).toHaveBeenCalledTimes(1)
    expect(onShip.mock.calls[0][0].kind).toBe('create-pr')
  })

  it('offers Publish to GitHub instead of Create PR in a repo with no remote', async () => {
    installApi({ ...sampleChanges, ship: { hasCommits: false, remote: null } })
    const onShip = vi.fn()
    render(<DiffPanel workspace="/repo" onShip={onShip} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Publish to GitHub' }))
    expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument()
    expect(screen.getByText(/No remote yet/)).toBeInTheDocument()
    expect(onShip.mock.calls[0][0].kind).toBe('publish')
    expect(onShip.mock.calls[0][0].prompt).toMatch(/gh_repo_create/)
  })

  it('offers Commit & push for a non-GitHub remote', async () => {
    installApi({
      ...sampleChanges,
      ship: { hasCommits: true, remote: { name: 'origin', host: 'other' } }
    })
    render(<DiffPanel workspace="/repo" onShip={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Commit & push' })).toBeInTheDocument()
  })

  it('disables Create PR while a run is in progress', async () => {
    installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" onShip={vi.fn()} creating />)
    expect(await screen.findByRole('button', { name: /Create PR/ })).toBeDisabled()
  })

  it('hides Create PR when there are no changes', async () => {
    installApi({ isRepo: true, branch: 'main', files: [], added: 0, removed: 0 })
    render(<DiffPanel workspace="/repo" onShip={vi.fn()} />)
    expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument()
  })

  it('shows the commit form when asked to, for a repository', async () => {
    installApi(sampleChanges)
    const gitBranchSync = vi.fn().mockResolvedValue({ branch: 'feature/x', upstream: null, ahead: 0, remote: null })
    window.api = { ...window.api, gitBranchSync } as unknown as typeof window.api
    render(<DiffPanel workspace="/repo" commitForm conversationId="c1" />)
    expect(await screen.findByLabelText('Commit message')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Suggest message' })).toBeInTheDocument()
    expect(gitBranchSync).toHaveBeenCalledWith('/repo')
  })

  it('offers the turn and chat scopes only once the chat exists', async () => {
    installApi(sampleChanges)
    const { unmount } = render(<DiffPanel workspace="/repo" />)
    await screen.findByText('src/foo.ts')
    expect(screen.getByRole('radio', { name: 'This turn' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'This chat' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'Working tree' })).toHaveAttribute('aria-checked', 'true')
    unmount()
  })

  it('loads the chat scopes from the checkpoints and remembers the choice', async () => {
    const chat: ChatChanges = {
      files: [
        {
          path: 'src/turn.ts',
          status: 'modified',
          added: 1,
          removed: 0,
          binary: false,
          hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [{ type: 'ctx', text: 'a' }, { type: 'add', text: 'b' }] }]
        }
      ],
      added: 1,
      removed: 0,
      unavailable: 2
    }
    const { getChatChanges } = installApi(sampleChanges, chat)
    const { unmount } = render(<DiffPanel workspace="/repo" conversationId="c1" />)
    await screen.findByText('src/foo.ts')
    fireEvent.click(screen.getByRole('radio', { name: 'This turn' }))
    expect(await screen.findByText('src/turn.ts')).toBeInTheDocument()
    expect(getChatChanges).toHaveBeenCalledWith('c1', 'turn')
    expect(screen.getByText(/changes from 2 turns are not shown/)).toBeInTheDocument()
    unmount()
    // Reopened, the view starts on the scope chosen last.
    render(<DiffPanel workspace="/repo" conversationId="c1" />)
    await screen.findByText('src/turn.ts')
    expect(screen.getByRole('radio', { name: 'This turn' })).toHaveAttribute('aria-checked', 'true')
  })

  it('ignores a slow reply for a scope the user already switched away from', async () => {
    const chat: ChatChanges = {
      files: [
        {
          path: 'src/turn.ts',
          status: 'modified',
          added: 1,
          removed: 0,
          binary: false,
          hunks: [{ header: '@@ -1,1 +1,2 @@', lines: [{ type: 'ctx', text: 'a' }, { type: 'add', text: 'b' }] }]
        }
      ],
      added: 1,
      removed: 0,
      unavailable: 0
    }
    const { getWorkingTreeChanges } = installApi(sampleChanges, chat)
    let resolveTree: (v: WorkingTreeChanges) => void = () => {}
    getWorkingTreeChanges.mockImplementation(() => new Promise((r) => (resolveTree = r)))
    render(<DiffPanel workspace="/repo" conversationId="c1" />)
    fireEvent.click(screen.getByRole('radio', { name: 'This turn' }))
    expect(await screen.findByText('src/turn.ts')).toBeInTheDocument()
    await act(async () => resolveTree(sampleChanges))
    expect(getWorkingTreeChanges).toHaveBeenCalledTimes(1)
    expect(screen.getByText('src/turn.ts')).toBeInTheDocument()
    expect(screen.queryByText(/changed no files/)).not.toBeInTheDocument()
  })

  it('reverts a file only after confirming, sending what it showed', async () => {
    const { revertChange, getWorkingTreeChanges } = installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" conversationId="c1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revert src/foo.ts' }))
    // Cancel is focused, so Enter never discards by accident.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText(/Discard all uncommitted changes to src\/foo.ts\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(revertChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Revert src/foo.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() =>
      expect(revertChange).toHaveBeenCalledWith({
        scope: 'tree',
        workspace: '/repo',
        conversationId: 'c1',
        path: 'src/foo.ts',
        signature: fileDiffSignature(sampleChanges.files[0])
      })
    )
    // The list is read again afterwards.
    await waitFor(() => expect(getWorkingTreeChanges).toHaveBeenCalledTimes(2))
  })

  it('reverts a single hunk of an edited file, and says why a revert failed', async () => {
    const { revertChange } = installApi(sampleChanges)
    revertChange.mockResolvedValue({ ok: false, error: 'This file changed since the list was loaded. Refresh and try again.' })
    render(<DiffPanel workspace="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Revert change 1 in src/foo.ts' }))
    fireEvent.click(screen.getByRole('button', { name: 'Revert' }))
    await waitFor(() => expect(revertChange).toHaveBeenCalledWith(expect.objectContaining({ path: 'src/foo.ts', hunk: 0 })))
    expect(await screen.findByText(/changed since the list was loaded/)).toBeInTheDocument()
    // An untracked file has no per-hunk revert: it is reverted (deleted) as a whole.
    expect(screen.queryByRole('button', { name: 'Revert change 1 in new.txt' })).not.toBeInTheDocument()
  })

  it('offers no revert while the chat is running', async () => {
    installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" conversationId="c1" running />)
    await screen.findByText('src/foo.ts')
    expect(screen.queryByRole('button', { name: 'Revert src/foo.ts' })).not.toBeInTheDocument()
  })

  it('opens a file and switches to side by side', async () => {
    const { openWorkspacePath } = installApi(sampleChanges)
    const { container } = render(<DiffPanel workspace="/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Open src/foo.ts' }))
    expect(openWorkspacePath).toHaveBeenCalledWith('/repo', 'src/foo.ts')
    expect(container.querySelector('pre.diff--split')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    expect(container.querySelector('pre.diff--split')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Side by side' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('words each confirmation by what the revert does', () => {
    const f = sampleChanges.files
    expect(revertQuestion(f[1], 'tree')).toBe('Delete new.txt? It is not committed.')
    expect(revertQuestion(f[0], 'turn')).toBe('Put src/foo.ts back as it was before this turn?')
    expect(revertQuestion(f[0], 'chat')).toBe('Put src/foo.ts back as it was before this chat?')
    expect(revertQuestion(f[0], 'tree', 0)).toBe('Undo this change in src/foo.ts?')
  })

  it('collects line comments and sends them as one message', async () => {
    installApi(sampleChanges)
    const onSendComments = vi.fn()
    render(<DiffPanel workspace="/repo" conversationId="c1" onSendComments={onSendComments} />)
    // The line number is the keyboard way in; a click on the line works too.
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 1 of src/foo.ts' }))
    const box = screen.getByLabelText('Comment on src/foo.ts line 1')
    expect(document.activeElement).toBe(box)
    fireEvent.change(box, { target: { value: 'Name this constant.' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    expect(screen.getByText('Name this constant.')).toBeInTheDocument()
    expect(screen.getByText('1 comment on 1 file')).toBeInTheDocument()

    // A removed line can take a comment too.
    fireEvent.click(screen.getByRole('button', { name: 'Comment on removed line 1 of src/foo.ts' }))
    fireEvent.change(screen.getByLabelText('Comment on src/foo.ts line 1'), { target: { value: 'Why drop 2?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))

    fireEvent.click(screen.getByRole('button', { name: 'Send 2 comments to the agent' }))
    expect(onSendComments).toHaveBeenCalledWith([
      { path: 'src/foo.ts', side: 'old', line: 1, code: 'const b = 2', body: 'Why drop 2?' },
      { path: 'src/foo.ts', side: 'new', line: 1, code: 'const b = 3', body: 'Name this constant.' }
    ])
    // Sent comments are cleared.
    expect(screen.queryByText('Name this constant.')).not.toBeInTheDocument()
  })

  it('keeps unsent comments when the view closes, and edits or deletes them', async () => {
    installApi(sampleChanges)
    const { unmount } = render(<DiffPanel workspace="/repo" conversationId="c1" onSendComments={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 2 of new.txt' }))
    fireEvent.change(screen.getByLabelText('Comment on new.txt line 2'), { target: { value: 'Say goodbye too' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    unmount()
    render(<DiffPanel workspace="/repo" conversationId="c1" onSendComments={vi.fn()} />)
    expect(await screen.findByText('Say goodbye too')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const box = screen.getByLabelText('Comment on new.txt line 2')
    fireEvent.change(box, { target: { value: 'Say goodbye as well' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    expect(screen.getByText('Say goodbye as well')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.queryByText('Say goodbye as well')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Send .* to the agent/ })).not.toBeInTheDocument()
  })

  it('lists a comment as outdated once a refresh moves its line, instead of under other code', async () => {
    const { getWorkingTreeChanges } = installApi(sampleChanges)
    const onSendComments = vi.fn()
    render(<DiffPanel workspace="/repo" conversationId="c1" onSendComments={onSendComments} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 1 of src/foo.ts' }))
    fireEvent.change(screen.getByLabelText('Comment on src/foo.ts line 1'), { target: { value: 'Name this constant.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    expect(screen.queryByRole('region', { name: 'Comments not on a line shown here' })).not.toBeInTheDocument()

    // The file gains a line above, so line 1 now holds different code.
    const shifted: WorkingTreeChanges = {
      ...sampleChanges,
      files: [
        {
          ...sampleChanges.files[0],
          hunks: [
            {
              header: '@@ -1,2 +1,3 @@',
              lines: [
                { type: 'add', text: 'import x' },
                { type: 'del', text: 'const b = 2' },
                { type: 'add', text: 'const b = 4' }
              ]
            }
          ]
        },
        sampleChanges.files[1]
      ]
    }
    getWorkingTreeChanges.mockResolvedValue(shifted)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    const outdated = await screen.findByRole('region', { name: 'Comments not on a line shown here' })
    expect(getWorkingTreeChanges).toHaveBeenCalledTimes(2)
    expect(outdated).toHaveTextContent('Name this constant.')
    expect(outdated).toHaveTextContent('const b = 3')
    // Not under the diff any more, but still counted, editable, and sent.
    expect(screen.getAllByText('Name this constant.')).toHaveLength(1)
    expect(screen.getByText('1 comment on 1 file')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Comment on src/foo.ts line 1'), { target: { value: 'Rename it.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send 1 comment to the agent' }))
    expect(onSendComments).toHaveBeenCalledWith([
      { path: 'src/foo.ts', side: 'new', line: 1, code: 'const b = 3', body: 'Rename it.' }
    ])
  })

  it('asks before discarding every comment, and cancels an open editor with Esc', async () => {
    installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" conversationId="c1" onSendComments={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 1 of src/foo.ts' }))
    fireEvent.keyDown(screen.getByLabelText('Comment on src/foo.ts line 1'), { key: 'Escape' })
    expect(screen.queryByLabelText('Comment on src/foo.ts line 1')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Comment on line 1 of src/foo.ts' }))
    fireEvent.change(screen.getByLabelText('Comment on src/foo.ts line 1'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
    expect(screen.getByText('x')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    fireEvent.click(screen.getByRole('button', { name: 'Discard all' }))
    expect(screen.queryByText('1 comment on 1 file')).not.toBeInTheDocument()
  })

  it('takes no comments without a way to send them, and holds sending while a run is busy', async () => {
    installApi(sampleChanges)
    const { unmount } = render(<DiffPanel workspace="/repo" />)
    await screen.findByText('src/foo.ts')
    expect(screen.queryByRole('button', { name: 'Comment on line 1 of src/foo.ts' })).not.toBeInTheDocument()
    unmount()
    render(<DiffPanel workspace="/repo" conversationId="c2" onSendComments={vi.fn()} creating />)
    fireEvent.click(await screen.findByRole('button', { name: 'Comment on line 1 of src/foo.ts' }))
    fireEvent.change(screen.getByLabelText('Comment on src/foo.ts line 1'), { target: { value: 'later' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }))
    expect(screen.getByRole('button', { name: 'Send 1 comment to the agent' })).toBeDisabled()
  })
})
