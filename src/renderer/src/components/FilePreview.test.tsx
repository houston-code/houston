import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { FilePreview as FilePreviewData } from '@shared/files'
import { FilePreview } from './FilePreview'

function installApi(preview: FilePreviewData) {
  const readWorkspaceFile = vi.fn().mockResolvedValue(preview)
  window.api = { readWorkspaceFile } as unknown as typeof window.api
  return { readWorkspaceFile }
}

describe('FilePreview', () => {
  it('shows a placeholder when nothing is selected', () => {
    installApi({ kind: 'text', text: '', truncated: false, bytes: 0 })
    render(<FilePreview workspace="/repo" path={null} onReveal={vi.fn()} />)
    expect(screen.getByText('Select a file to preview it here.')).toBeInTheDocument()
  })

  it('renders text with the path and a line-number gutter', async () => {
    installApi({ kind: 'text', text: 'line one\nline two', truncated: false, bytes: 17 })
    // .txt isn't a highlighted language, so the pane is a single plain text node.
    const { container } = render(<FilePreview workspace="/repo" path="src/a.txt" onReveal={vi.fn()} />)
    expect(await screen.findByText('line one', { exact: false })).toBeInTheDocument()
    expect(screen.getByText('src/a.txt')).toBeInTheDocument()
    // Two lines → a "1\n2" gutter.
    expect(container.querySelector('.file-preview__gutter')?.textContent).toBe('1\n2\n')
  })

  it('syntax-highlights a known code language into token spans', async () => {
    installApi({ kind: 'text', text: 'const x = 1', truncated: false, bytes: 11 })
    const { container } = render(<FilePreview workspace="/repo" path="src/a.ts" onReveal={vi.fn()} />)
    const pane = await screen.findByText(
      (_, el) => el?.className === 'file-preview__text hljs'
    )
    expect(pane.querySelector('.hljs-keyword')).not.toBeNull() // `const`
    // The full source text survives across the token spans.
    expect(container.querySelector('.file-preview__text')?.textContent).toBe('const x = 1')
  })

  it('notes truncation for a capped large file', async () => {
    installApi({ kind: 'text', text: 'partial', truncated: true, bytes: 2_000_000 })
    render(<FilePreview workspace="/repo" path="big.log" onReveal={vi.fn()} />)
    expect(await screen.findByText(/Showing the first/)).toBeInTheDocument()
  })

  it('renders an image as an <img>', async () => {
    installApi({ kind: 'image', image: { mediaType: 'image/png', data: 'ZZZZ' }, bytes: 3 })
    render(<FilePreview workspace="/repo" path="a.png" onReveal={vi.fn()} />)
    const img = await screen.findByAltText('a.png')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,ZZZZ')
  })

  it('falls back to a note for binary files', async () => {
    installApi({ kind: 'binary', bytes: 4096 })
    render(<FilePreview workspace="/repo" path="a.bin" onReveal={vi.fn()} />)
    expect(await screen.findByText(/Binary file/)).toBeInTheDocument()
  })

  it('falls back to a note for oversize files', async () => {
    installApi({ kind: 'too-large', bytes: 9_000_000, limit: 5_000_000 })
    render(<FilePreview workspace="/repo" path="huge.bin" onReveal={vi.fn()} />)
    expect(await screen.findByText(/too large to preview/)).toBeInTheDocument()
  })

  it('surfaces a read error', async () => {
    installApi({ kind: 'error', message: 'boom' })
    render(<FilePreview workspace="/repo" path="x" onReveal={vi.fn()} />)
    expect(await screen.findByText(/Couldn’t open this file: boom/)).toBeInTheDocument()
  })

  it('renders markdown files, with a Source toggle back to raw text', async () => {
    installApi({ kind: 'text', text: '# Title\n\nbody text', truncated: false, bytes: 17 })
    const { container } = render(<FilePreview workspace="/repo" path="README.md" onReveal={vi.fn()} />)
    // Rendered view: an <h1> heading, not literal "# Title".
    expect(await screen.findByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument()
    expect(screen.queryByText('# Title', { exact: false })).not.toBeInTheDocument()

    // Toggle to source shows the raw markdown in the (highlighted) code pane.
    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(container.querySelector('.file-preview__text')?.textContent).toContain('# Title')
    expect(screen.queryByRole('heading', { name: 'Title' })).not.toBeInTheDocument()
  })

  it('renders an SVG file as an image, toggleable to source', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>'
    installApi({ kind: 'text', text: svg, truncated: false, bytes: svg.length })
    const { container } = render(<FilePreview workspace="/repo" path="icon.svg" onReveal={vi.fn()} />)
    const img = await screen.findByAltText('icon.svg')
    expect(img.getAttribute('src')).toBe(`data:image/svg+xml,${encodeURIComponent(svg)}`)

    fireEvent.click(screen.getByRole('button', { name: 'Source' }))
    expect(container.querySelector('.file-preview__text')?.textContent).toContain('rect width')
    expect(screen.queryByAltText('icon.svg')).not.toBeInTheDocument()
  })

  it('calls onReveal with the path from the header button', async () => {
    installApi({ kind: 'text', text: 'hi', truncated: false, bytes: 2 })
    const onReveal = vi.fn()
    render(<FilePreview workspace="/repo" path="src/a.ts" onReveal={onReveal} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }))
    expect(onReveal).toHaveBeenCalledWith('src/a.ts')
  })
})
