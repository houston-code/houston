import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { stepIndex, galleryViewerImages, workspaceRelativePath, type ViewerImage } from '../lib/imageViewer'
import { ImageViewer } from './ImageViewer'

const IMAGES: ViewerImage[] = [
  { src: 'data:image/png;base64,AAAA', label: 'Light theme', caption: 'Default look.', path: 'shots/light.png' },
  { src: 'data:image/png;base64,BBBB', label: 'Dark theme', path: 'shots/dark.png' },
  { src: 'data:image/png;base64,CCCC', label: 'Mobile' }
]

const dialog = (): HTMLElement => screen.getByRole('dialog')

describe('ImageViewer', () => {
  it('shows the starting image with its label, position, path, and caption', () => {
    render(<ImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} />)
    expect(dialog()).toHaveAttribute('aria-label', 'Light theme')
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.getByText('shots/light.png')).toBeInTheDocument()
    expect(screen.getByText('Default look.')).toBeInTheDocument()
    expect(screen.getByRole('img')).toHaveAttribute('src', IMAGES[0].src)
  })

  it('steps with the arrow buttons and keys, wrapping at both ends', () => {
    render(<ImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' })
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' })
    expect(screen.getByText('3 of 3')).toBeInTheDocument()
    // The last image has no path, so neither the path nor "Open file" shows.
    expect(screen.queryByRole('button', { name: 'Open file' })).not.toBeInTheDocument()
  })

  it('hides the arrows and count for a single image', () => {
    render(<ImageViewer images={[IMAGES[1]]} initialIndex={0} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument()
    expect(screen.queryByText('1 of 1')).not.toBeInTheDocument()
  })

  it('closes on Escape, the close button, and a backdrop click, but not a click on the image', () => {
    const onClose = vi.fn()
    const { container } = render(<ImageViewer images={IMAGES} initialIndex={0} onClose={onClose} />)
    fireEvent.click(screen.getByRole('img'))
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(container.querySelector('.image-viewer')!)
    expect(onClose).toHaveBeenCalledTimes(3)
  })

  it('focuses the close button on open', () => {
    render(<ImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus()
  })

  it('opens the file and shows the reason when that fails', async () => {
    const onOpenFile = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('That file no longer exists.')
    render(<ImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} onOpenFile={onOpenFile} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    expect(onOpenFile).toHaveBeenCalledWith('shots/light.png')
    fireEvent.click(screen.getByRole('button', { name: 'Open file' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('That file no longer exists.'))
    // Moving on clears the error.
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('clamps an out-of-range starting index into the set', () => {
    render(<ImageViewer images={IMAGES} initialIndex={4} onClose={vi.fn()} />)
    expect(screen.getByText('2 of 3')).toBeInTheDocument()
  })
})

describe('stepIndex', () => {
  it('wraps both ways and tolerates an empty set', () => {
    expect(stepIndex(0, 1, 3)).toBe(1)
    expect(stepIndex(2, 1, 3)).toBe(0)
    expect(stepIndex(0, -1, 3)).toBe(2)
    expect(stepIndex(5, 0, 3)).toBe(2)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
})

describe('galleryViewerImages', () => {
  const gallery = {
    images: [
      { path: 'a.png', label: 'A', caption: 'First' },
      { path: 'b.png', label: 'B' }
    ]
  }

  it('pairs each entry with its attached image', () => {
    expect(
      galleryViewerImages(gallery, [
        { mediaType: 'image/png', data: 'AAAA' },
        { mediaType: 'image/webp', data: 'BBBB' }
      ])
    ).toEqual([
      { src: 'data:image/png;base64,AAAA', label: 'A', caption: 'First', path: 'a.png' },
      { src: 'data:image/webp;base64,BBBB', label: 'B', path: 'b.png' }
    ])
  })

  it('returns nothing when the counts differ or nothing was attached', () => {
    expect(galleryViewerImages(gallery, [{ mediaType: 'image/png', data: 'AAAA' }])).toEqual([])
    expect(galleryViewerImages(gallery, undefined)).toEqual([])
  })
})

describe('ImageViewer compare', () => {
  const withCompare: ViewerImage = {
    src: 'data:image/png;base64,AFTER',
    label: 'After',
    compare: { src: 'data:image/png;base64,BEFORE', label: 'before.png' }
  }

  it('offers Compare only for an image with something to compare against', () => {
    render(<ImageViewer images={[IMAGES[1], withCompare]} initialIndex={0} onClose={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }))
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows both images with a slider that moves the divider', () => {
    render(<ImageViewer images={[withCompare]} initialIndex={0} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(screen.getByAltText('before.png')).toHaveAttribute('src', 'data:image/png;base64,BEFORE')
    const slider = screen.getByRole('slider', { name: 'Divider between before.png and After' })
    fireEvent.change(slider, { target: { value: '30' } })
    expect(screen.getByAltText('After')).toHaveStyle({ clipPath: 'inset(0 0 0 30%)' })
  })

  it('leaves the arrow keys to the slider while it has focus', () => {
    render(<ImageViewer images={[withCompare, IMAGES[0]]} initialIndex={0} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' })
    expect(screen.getByText('1 of 2')).toBeInTheDocument()
  })
})

describe('ImageViewer actions', () => {
  it('copies and saves the current image and reports the result', async () => {
    const onCopy = vi.fn().mockResolvedValue({ ok: true, message: 'Copied' })
    const onSave = vi.fn().mockResolvedValue(null)
    render(<ImageViewer images={IMAGES} initialIndex={1} onClose={vi.fn()} onCopy={onCopy} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    expect(onCopy).toHaveBeenCalledWith(IMAGES[1])
    expect(await screen.findByRole('status')).toHaveTextContent('Copied')
    fireEvent.click(screen.getByRole('button', { name: 'Save image…' }))
    expect(onSave).toHaveBeenCalledWith(IMAGES[1])
  })

  it('shows a file in the Files panel, or says why it cannot', () => {
    const onShowInFiles = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce('That file is outside the project folder.')
    render(<ImageViewer images={IMAGES} initialIndex={0} onClose={vi.fn()} onShowInFiles={onShowInFiles} />)
    fireEvent.click(screen.getByRole('button', { name: 'Show in Files' }))
    expect(onShowInFiles).toHaveBeenCalledWith('shots/light.png')
    fireEvent.click(screen.getByRole('button', { name: 'Show in Files' }))
    expect(screen.getByRole('alert')).toHaveTextContent('outside the project folder')
  })
})

describe('gallery compare pairing', () => {
  it('pairs each compareWith with the images attached after the entries', () => {
    const imgs = galleryViewerImages(
      {
        images: [
          { path: 'after/a.png', label: 'A', compareWith: 'before/a.png' },
          { path: 'after/b.png', label: 'B' },
          { path: 'after/c.png', label: 'C', compareWith: 'before/c.png' }
        ]
      },
      ['A1', 'B1', 'C1', 'A0', 'C0'].map((d) => ({ mediaType: 'image/png', data: d }))
    )
    expect(imgs.map((i) => [i.src.slice(-2), i.compare?.src.slice(-2), i.compare?.label])).toEqual([
      ['A1', 'A0', 'a.png'],
      ['B1', undefined, undefined],
      ['C1', 'C0', 'c.png']
    ])
  })
})

describe('workspaceRelativePath', () => {
  it('maps project paths for the Files panel and refuses ones outside it', () => {
    expect(workspaceRelativePath('shots/a.png', '/repo')).toBe('shots/a.png')
    expect(workspaceRelativePath('./shots/a.png', '/repo')).toBe('shots/a.png')
    expect(workspaceRelativePath('/repo/shots/a.png', '/repo/')).toBe('shots/a.png')
    expect(workspaceRelativePath('C:\\repo\\a.png', 'C:\\repo')).toBe('a.png')
    expect(workspaceRelativePath('/elsewhere/a.png', '/repo')).toBeNull()
    expect(workspaceRelativePath('../a.png', '/repo')).toBeNull()
    expect(workspaceRelativePath('/repository/a.png', '/repo')).toBeNull()
  })
})
