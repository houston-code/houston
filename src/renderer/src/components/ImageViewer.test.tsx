import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { stepIndex, galleryViewerImages, type ViewerImage } from '../lib/imageViewer'
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
