import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FileEntry, FilePreview } from '@shared/files'
import { FilesPanel, normalizeRelPath } from './FilesPanel'

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
  const openWorkspacePath = vi.fn().mockResolvedValue({ ok: true })
  const listWorkspaceFiles = vi.fn().mockResolvedValue([])
  window.api = {
    listWorkspaceDir,
    readWorkspaceFile,
    openWorkspacePath,
    listWorkspaceFiles
  } as unknown as typeof window.api
  return { listWorkspaceDir, readWorkspaceFile, openWorkspacePath, listWorkspaceFiles }
}

const dir = (name: string, path: string): FileEntry => ({ name, path, isDirectory: true })
const file = (name: string, path: string): FileEntry => ({ name, path, isDirectory: false })

describe('FilesPanel', () => {
  it('starts focus in the filter field and closes on Esc', async () => {
    installApi({ '': [file('README.md', 'README.md')] })
    const onClose = vi.fn()
    render(<FilesPanel workspace="/ws" onClose={onClose} />)
    expect(document.activeElement).toBe(screen.getByLabelText('Filter files'))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('docked in the side panel: no dialog, no close button, and focus stays where it was', async () => {
    installApi({ '': [file('README.md', 'README.md')] })
    const onClose = vi.fn()
    render(
      <>
        <textarea aria-label="message" />
        <FilesPanel workspace="/ws" onClose={onClose} docked />
      </>
    )
    const box = screen.getByLabelText('message')
    box.focus()
    expect(await screen.findByText('README.md')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: 'Files' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(document.activeElement).toBe(box)
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lists the workspace root', async () => {
    installApi({ '': [dir('src', 'src'), file('README.md', 'README.md')] })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    expect(await screen.findByText('src')).toBeInTheDocument()
    expect(screen.getByText('README.md')).toBeInTheDocument()
  })

  it('names the refresh button for screen readers and draws it as an icon', async () => {
    installApi({ '': [file('README.md', 'README.md')] })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    await screen.findByText('README.md')
    const refresh = screen.getByRole('button', { name: 'Refresh' })
    expect(refresh.querySelector('svg[data-icon="refresh"]')).toBeInTheDocument()
    expect(refresh).not.toHaveTextContent('⟳')
  })

  it('names the workspace folder in the subtitle', async () => {
    installApi({ '': [] })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    expect(
      screen.getByText('Every file in repo. Click a folder to expand it, or a file to preview it.')
    ).toBeInTheDocument()
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

  it('opens the selected file via the preview header button', async () => {
    const api = installApi({ '': [file('README.md', 'README.md')] })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('README.md'))
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }))
    expect(api.openWorkspacePath).toHaveBeenCalledWith('/repo', 'README.md')
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

describe('FilesPanel opened at a file', () => {
  it('expands the folders above the file and previews it', async () => {
    const api = installApi({
      '': [dir('e2e', 'e2e')],
      e2e: [dir('screens', 'e2e/screens')],
      'e2e/screens': [file('home.png', 'e2e/screens/home.png')]
    })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} initialPath="./e2e/screens/home.png" />)
    expect(await screen.findByText('home.png')).toBeInTheDocument()
    expect(api.listWorkspaceDir).toHaveBeenCalledWith('/repo', 'e2e')
    expect(api.listWorkspaceDir).toHaveBeenCalledWith('/repo', 'e2e/screens')
    await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('/repo', 'e2e/screens/home.png'))
  })

  it('Refresh keeps the file picked since and the folders opened since', async () => {
    installApi({
      '': [dir('e2e', 'e2e'), dir('src', 'src'), file('README.md', 'README.md')],
      e2e: [file('a.png', 'e2e/a.png')],
      src: [file('main.ts', 'src/main.ts')]
    })
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} initialPath="e2e/a.png" docked />)
    expect(await screen.findByText('a.png')).toBeInTheDocument()
    // The user opens another folder and picks another file there.
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /main\.ts/ }))
    const selectedName = (): string | null =>
      document.querySelector('.files-row__btn--selected .files-row__name')?.textContent ?? null
    await waitFor(() => expect(selectedName()).toBe('main.ts'))

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled())
    expect(selectedName()).toBe('main.ts')
    expect(screen.getByText('main.ts')).toBeInTheDocument()
    expect(screen.getByText('a.png')).toBeInTheDocument()
  })

  it('normalizes the paths it is given', () => {
    expect(normalizeRelPath('./a/b.png')).toBe('a/b.png')
    expect(normalizeRelPath('a\\b.png')).toBe('a/b.png')
    expect(normalizeRelPath('/a/')).toBe('a')
  })
})

describe('FilesPanel keyboard (tree pattern)', () => {
  const tree = {
    '': [dir('src', 'src'), file('README.md', 'README.md')],
    src: [dir('lib', 'src/lib'), file('main.ts', 'src/main.ts')],
    'src/lib': [file('util.ts', 'src/lib/util.ts')]
  }
  const item = (name: RegExp): HTMLElement => screen.getByRole('treeitem', { name })
  const key = (k: string): void => {
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: k })
  }

  it('is one Tab stop, and the arrow keys walk, open, and close folders', async () => {
    const api = installApi(tree)
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} docked />)
    const src = await screen.findByRole('treeitem', { name: /\bsrc$/ })
    // Only the first row is in the Tab order.
    expect(src).toHaveAttribute('tabindex', '0')
    expect(item(/README/)).toHaveAttribute('tabindex', '-1')
    expect(src).toHaveAttribute('aria-level', '1')
    expect(src).toHaveAttribute('aria-expanded', 'false')

    src.focus()
    key('ArrowDown')
    expect(document.activeElement).toBe(item(/README/))
    key('ArrowUp')
    expect(document.activeElement).toBe(src)

    // Right opens a closed folder (loading it), and again steps into it.
    key('ArrowRight')
    expect(await screen.findByRole('treeitem', { name: /main\.ts/ })).toBeInTheDocument()
    expect(api.listWorkspaceDir).toHaveBeenCalledWith('/repo', 'src')
    expect(src).toHaveAttribute('aria-expanded', 'true')
    key('ArrowRight')
    expect(document.activeElement).toBe(item(/\blib$/))
    expect(item(/\blib$/)).toHaveAttribute('aria-level', '2')
    // The focused row takes over the Tab stop.
    expect(item(/\blib$/)).toHaveAttribute('tabindex', '0')
    expect(src).toHaveAttribute('tabindex', '-1')

    // Left on a closed folder goes to its parent; Left on an open one closes it.
    key('ArrowLeft')
    expect(document.activeElement).toBe(src)
    key('ArrowLeft')
    expect(src).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('treeitem', { name: /main\.ts/ })).toBeNull()

    key('End')
    expect(document.activeElement).toBe(item(/README/))
    key('Home')
    expect(document.activeElement).toBe(src)
    // Right on a file stays put.
    key('End')
    key('ArrowRight')
    expect(document.activeElement).toBe(item(/README/))
  })

  it('makes the selected file the Tab stop when the panel opens on it', async () => {
    installApi(tree)
    render(<FilesPanel workspace="/repo" onClose={vi.fn()} initialPath="src/main.ts" docked />)
    const main = await screen.findByRole('treeitem', { name: /main\.ts/ })
    expect(main).toHaveAttribute('tabindex', '0')
    expect(main).toHaveAttribute('aria-selected', 'true')
    expect(screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0)).toHaveLength(1)
  })
})
