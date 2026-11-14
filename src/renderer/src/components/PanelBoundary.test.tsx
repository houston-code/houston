import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkingTreeChanges } from '@shared/workingTree'

// A diff hunk and a file preview whose renderers throw, the way a bug triggered by
// some hostile file name or content would. Neither panel used to sit inside an
// error boundary, so the throw reached the app-level one and blanked the window,
// and since the dock remembers its open tab it did so again on every launch.
vi.mock('./DiffView', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./DiffView')>()),
  DiffView: () => {
    throw new Error('diff failed')
  }
}))
vi.mock('./FilePreview', () => ({
  FilePreview: () => {
    throw new Error('preview failed')
  }
}))

import { DiffPanel } from './DiffPanel'
import { FilesPanel } from './FilesPanel'

afterEach(() => vi.restoreAllMocks())

const changes: WorkingTreeChanges = {
  isRepo: true,
  branch: 'main',
  added: 1,
  removed: 0,
  files: [
    {
      path: 'constructor',
      status: 'untracked',
      added: 1,
      removed: 0,
      binary: false,
      hunks: [{ header: '@@ -0,0 +1 @@', lines: [{ type: 'add', text: 'x' }] }]
    }
  ]
}

describe('panel error boundaries', () => {
  it('a hunk that fails to render becomes a notice inside the Changes panel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.api = {
      getWorkingTreeChanges: vi.fn().mockResolvedValue(changes),
      getChatChanges: vi.fn().mockResolvedValue({ files: [], added: 0, removed: 0, unavailable: 0 }),
      readWorkspaceFile: vi.fn().mockResolvedValue({ kind: 'error', message: 'no file' })
    } as unknown as typeof window.api
    render(<DiffPanel workspace="/repo" />)
    expect(await screen.findByText("This item couldn't be shown.")).toBeInTheDocument()
    // The rest of the panel (the file row) is still there.
    expect(screen.getByText('constructor')).toBeInTheDocument()
  })

  it('a preview that fails to render becomes a notice inside the Files panel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.api = {
      listWorkspaceDir: vi.fn().mockResolvedValue([{ name: 'constructor', path: 'constructor', isDirectory: false }]),
      readWorkspaceFile: vi.fn(),
      openWorkspacePath: vi.fn(),
      listWorkspaceFiles: vi.fn().mockResolvedValue([])
    } as unknown as typeof window.api
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} initialPath="constructor" />)
    // Wait for the tree to load (the boundary re-tries when the selection lands on
    // the file, replacing the first notice with a fresh one).
    expect(await screen.findByText('constructor')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText("This item couldn't be shown.")).toBeInTheDocument())
    expect(screen.getByLabelText('Filter files')).toBeInTheDocument()
  })
})
