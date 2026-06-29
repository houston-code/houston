import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, FilePreview } from '@shared/files'
import { FilesPanel } from './FilesPanel'

/**
 * Install a fake `window.api` whose listWorkspaceDir resolves to the children of
 * each requested path (keyed by relative dir path; '' = root), and whose
 * readWorkspaceFile resolves to `preview` (a plain text file by default).
 */
function installApi(
  tree: Record<string, FileEntry[]>,
  preview: FilePreview = { kind: 'text', text: 'file body', truncated: false, bytes: 9 }
) {
  const listWorkspaceDir = vi.fn((_ws: string, rel: string) => Promise.resolve(tree[rel] ?? []))
  const readWorkspaceFile = vi.fn().mockResolvedValue(preview)
  const revealWorkspacePath = vi.fn().mockResolvedValue({ ok: true })
  const listWorkspaceFiles = vi.fn().mockResolvedValue([])
  window.api = {
    listWorkspaceDir,
    readWorkspaceFile,
    revealWorkspacePath,
    listWorkspaceFiles
  } as unknown as typeof window.api
  return { listWorkspaceDir, readWorkspaceFile, revealWorkspacePath, listWorkspaceFiles }
}

const dir = (name: string, path: string): FileEntry => ({ name, path, isDirectory: true })
const file = (name: string, path: string): FileEntry => ({ name, path, isDirectory: false })

describe('FilesPanel', () => {
  it('lists the workspace root', async () => {
    installApi({ '': [dir('src', 'src'), file('README.md', 'README.md')] })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('lazily loads a folder when expanded, then collapses it', async () => {
    const api = installApi({
      '': [dir('src', 'src')],
      src: [file('index.ts', 'src/index.ts')]
    })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)

    // Children aren't fetched until the folder is opened.
    fireEvent.click(await screen.findByText('src'))
    expect(await screen.findByText('index.ts')).toBeInTheDocument()
    expect(api.listWorkspaceDir).toHaveBeenCalledWith('/repo', 'src')

    // Collapsing hides the children again (and doesn't refetch on re-expand).
    fireEvent.click(screen.getByText('src'))
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('src'))
    expect(await screen.findByText('index.ts')).toBeInTheDocument()
    expect(api.listWorkspaceDir).toHaveBeenCalledTimes(2) // root + src once, not twice
  })

  it('previews a file in-app when clicked', async () => {
    const api = installApi(
      { '': [file('notes.txt', 'notes.txt')] },
      { kind: 'text', text: 'hello from the file', truncated: false, bytes: 19 }
    )
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('notes.txt'))
    expect(api.readWorkspaceFile).toHaveBeenCalledWith('/repo', 'notes.txt')
    expect(await screen.findByText('hello from the file')).toBeInTheDocument()
  })

  it('reveals the selected file via the preview header button', async () => {
    const api = installApi({ '': [file('README.md', 'README.md')] })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    expect(api.revealWorkspacePath).toHaveBeenCalledWith('/repo', 'README.md')
  })

  it('renders an image preview for an image file', async () => {
    installApi(
      { '': [file('logo.png', 'logo.png')] },
      { kind: 'image', image: { mediaType: 'image/png', data: 'AAAA' }, bytes: 3 }
    )
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('logo.png'))
    const img = await screen.findByAltText('logo.png')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('switches to flat fuzzy results while filtering', async () => {
    const api = installApi({ '': [dir('src', 'src')] })
    api.listWorkspaceFiles.mockResolvedValue(['src/deep/widget.ts'])
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    await screen.findByText('src')

    fireEvent.change(screen.getByLabelText('Filter files'), { target: { value: 'widget' } })
    expect(await screen.findByText('src/deep/widget.ts')).toBeInTheDocument()
    expect(api.listWorkspaceFiles).toHaveBeenCalledWith('/repo', 'widget')
    // The tree is replaced by results while a query is active.
    expect(screen.queryByText('src')).not.toBeInTheDocument()
  })

  it('prompts to open a project when there is no workspace', async () => {
    installApi({})
    render(<FilesPanel workspace={null} onClose={vi.fn()} />)
    expect(
      await screen.findByText('Open a chat in a project to browse its files.')
    ).toBeInTheDocument()
  })

  it('closes when the backdrop is clicked', async () => {
    installApi({ '': [file('README.md', 'README.md')] })
    const onClose = vi.fn()
    const { container } = render(<FilesPanel workspace="/repo" onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument())
    fireEvent.click(container.querySelector('.drawer-overlay')!)
    expect(onClose).toHaveBeenCalled()
  })
})
