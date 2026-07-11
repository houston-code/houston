import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkingTreeChanges } from '@shared/workingTree'
import { DiffPanel } from './DiffPanel'

/** Install a fake `window.api` whose getWorkingTreeChanges resolves to `data`. */
function installApi(data: WorkingTreeChanges) {
  const getWorkingTreeChanges = vi.fn().mockResolvedValue(data)
  const initGitRepo = vi.fn().mockResolvedValue({ ok: true })
  window.api = { getWorkingTreeChanges, initGitRepo } as unknown as typeof window.api
  return { getWorkingTreeChanges, initGitRepo }
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
  it('lists changed files with the working-tree scope label and totals', async () => {
    installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" onClose={vi.fn()} />)

    expect(await screen.findByText('src/foo.ts')).toBeInTheDocument()
    expect(screen.getByText('new.txt')).toBeInTheDocument()
    // The label makes the scope explicit so users don't read it as session-only.
    expect(screen.getByText(/All uncommitted changes in the working tree/)).toBeInTheDocument()
    expect(screen.getByText(/on feature\/x/)).toBeInTheDocument()
  })

  it('shows an empty state when the tree is clean', async () => {
    installApi({ isRepo: true, branch: 'main', files: [], added: 0, removed: 0 })
    render(<DiffPanel workspace="/repo" onClose={vi.fn()} />)
    expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument()
  })

  it('reports when the workspace is not a git repository', async () => {
    installApi({ isRepo: false, branch: null, files: [], added: 0, removed: 0 })
    render(<DiffPanel workspace="/tmp" onClose={vi.fn()} />)
    expect(await screen.findByText(/isn’t a git repository/)).toBeInTheDocument()
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

    render(<DiffPanel workspace="/tmp/app" onClose={vi.fn()} />)
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

    render(<DiffPanel workspace="/tmp/app" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: /Initialize git repository/ }))
    expect(await screen.findByText('git init failed.')).toBeInTheDocument()
  })

  it('closes when the backdrop is clicked', async () => {
    installApi(sampleChanges)
    const onClose = vi.fn()
    const { container } = render(<DiffPanel workspace="/repo" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('src/foo.ts')).toBeInTheDocument())
    fireEvent.click(container.querySelector('.drawer-overlay')!)
    expect(onClose).toHaveBeenCalled()
  })

  it('hands off to the agent when Create PR is clicked', async () => {
    installApi(sampleChanges)
    const onCreatePr = vi.fn()
    render(<DiffPanel workspace="/repo" onClose={vi.fn()} onCreatePr={onCreatePr} />)
    fireEvent.click(await screen.findByRole('button', { name: /Create PR/ }))
    expect(onCreatePr).toHaveBeenCalledTimes(1)
  })

  it('disables Create PR while a run is in progress', async () => {
    installApi(sampleChanges)
    render(<DiffPanel workspace="/repo" onClose={vi.fn()} onCreatePr={vi.fn()} creating />)
    expect(await screen.findByRole('button', { name: /Create PR/ })).toBeDisabled()
  })

  it('hides Create PR when there are no changes', async () => {
    installApi({ isRepo: true, branch: 'main', files: [], added: 0, removed: 0 })
    render(<DiffPanel workspace="/repo" onClose={vi.fn()} onCreatePr={vi.fn()} />)
    expect(await screen.findByText('No uncommitted changes.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument()
  })
})
