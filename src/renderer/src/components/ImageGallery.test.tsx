import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ToolItem } from '../lib/items'
import { ImageViewerContext, type ImageViewerApi } from '../lib/imageViewer'
import { ToolGroup } from './ToolGroup'

/**
 * A show_images row draws a gallery from its arguments (title, labels, captions)
 * and the images its result attached; tiles and tool-card screenshots open the
 * app's viewer through ImageViewerContext.
 */

function tool(over: Partial<ToolItem> & Pick<ToolItem, 'id' | 'name' | 'status'>): ToolItem {
  return { kind: 'tool', ...over } as ToolItem
}

const galleryRow = (over: Partial<ToolItem> = {}): ToolItem =>
  tool({
    id: 'g',
    name: 'show_images',
    status: 'done',
    args: {
      title: 'Settings page',
      images: [
        { path: 'shots/light.png', label: 'Light theme', caption: 'Default look.' },
        { path: 'shots/dark.png', label: 'Dark theme' }
      ]
    },
    images: [
      { mediaType: 'image/png', data: 'AAAA' },
      { mediaType: 'image/png', data: 'BBBB' }
    ],
    ...over
  })

function renderWithViewer(items: ToolItem[]): { open: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  const api: ImageViewerApi = { open }
  render(
    <ImageViewerContext.Provider value={api}>
      <ToolGroup items={items} onApprove={vi.fn()} />
    </ImageViewerContext.Provider>
  )
  return { open }
}

describe('show_images gallery row', () => {
  it('shows the title, count, and a labelled tile per image', () => {
    renderWithViewer([galleryRow()])
    expect(screen.getByRole('region', { name: 'Settings page' })).toBeInTheDocument()
    expect(screen.getByText('2 images')).toBeInTheDocument()
    expect(screen.getByText('Light theme')).toBeInTheDocument()
    expect(screen.getByText('Dark theme')).toHaveAttribute('title', 'shots/dark.png')
    expect(screen.getByAltText('Default look.')).toHaveAttribute('src', 'data:image/png;base64,AAAA')
  })

  it('opens the viewer at the clicked tile with the whole set', () => {
    const { open } = renderWithViewer([galleryRow()])
    fireEvent.click(screen.getByRole('button', { name: 'Open Dark theme full size' }))
    expect(open).toHaveBeenCalledWith(
      [
        { src: 'data:image/png;base64,AAAA', label: 'Light theme', caption: 'Default look.', path: 'shots/light.png' },
        { src: 'data:image/png;base64,BBBB', label: 'Dark theme', path: 'shots/dark.png' }
      ],
      1
    )
  })

  it('draws no gallery while the call is still running', () => {
    renderWithViewer([galleryRow({ status: 'running', images: undefined })])
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })

  it('draws no gallery when the images do not match the entries', () => {
    const { container } = render(
      <ToolGroup items={[galleryRow({ images: [{ mediaType: 'image/png', data: 'AAAA' }] })]} onApprove={vi.fn()} />
    )
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
    // The image still shows, unlabelled, as any tool image would.
    expect(container.querySelectorAll('img.tool-row__image')).toHaveLength(1)
  })

  it('describes the row by its title and count', () => {
    renderWithViewer([galleryRow()])
    expect(screen.getByText('Show')).toBeInTheDocument()
    expect(screen.getByText('Settings page (2 images)')).toBeInTheDocument()
  })
})

describe('render_mockup gallery row', () => {
  const mockupRow = (over: Partial<ToolItem> = {}): ToolItem =>
    tool({
      id: 'm',
      name: 'render_mockup',
      status: 'done',
      args: { file: 'mockups/settings.html', variants: ['desktop-light', { preset: 'mobile', colorScheme: 'dark', label: 'Phone' }] },
      images: [
        { mediaType: 'image/png', data: 'AAAA' },
        { mediaType: 'image/png', data: 'BBBB' }
      ],
      ...over
    })

  it('labels each render by its variant and marks the set as a mockup', () => {
    renderWithViewer([mockupRow()])
    expect(screen.getByRole('region', { name: 'Mockup: mockups/settings.html' })).toBeInTheDocument()
    expect(screen.getByText('Mockup from code')).toBeInTheDocument()
    expect(screen.getByText('Desktop, light')).toBeInTheDocument()
    expect(screen.getByText('Phone')).toBeInTheDocument()
    expect(screen.getByText('Render')).toBeInTheDocument()
    expect(screen.getByText('mockups/settings.html (2 variants)')).toBeInTheDocument()
  })

  it('opens the viewer with a caption and no file to open', () => {
    const { open } = renderWithViewer([mockupRow()])
    fireEvent.click(screen.getByRole('button', { name: 'Open Phone full size' }))
    const [images, index] = open.mock.calls[0]
    expect(index).toBe(1)
    expect(images[1]).toEqual({
      src: 'data:image/png;base64,BBBB',
      label: 'Phone',
      caption: 'settings.html at 390×844, dark color scheme.'
    })
  })

  it('draws no gallery for a failed render', () => {
    renderWithViewer([mockupRow({ status: 'error', images: undefined, output: 'Error: No such file' })])
    expect(screen.queryByRole('region')).not.toBeInTheDocument()
  })
})

describe('tool-card screenshots', () => {
  it('open the viewer when clicked', () => {
    const { open } = renderWithViewer([
      tool({
        id: 'v',
        name: 'view_localhost',
        status: 'done',
        args: { url: 'http://localhost:3000' },
        images: [
          { mediaType: 'image/png', data: 'AAAA' },
          { mediaType: 'image/jpeg', data: 'BBBB' }
        ]
      })
    ])
    fireEvent.click(screen.getByRole('button', { name: 'Open image 2 full size' }))
    expect(open).toHaveBeenCalledWith(
      [
        { src: 'data:image/png;base64,AAAA', label: 'Image 1' },
        { src: 'data:image/jpeg;base64,BBBB', label: 'Image 2' }
      ],
      1
    )
  })

  it('stay plain images outside the viewer provider', () => {
    const { container } = render(
      <ToolGroup
        items={[
          tool({
            id: 'v',
            name: 'read_file',
            status: 'done',
            args: { path: 'a.png' },
            images: [{ mediaType: 'image/png', data: 'AAAA' }]
          })
        ]}
        onApprove={vi.fn()}
      />
    )
    expect(container.querySelector('.tool-row__image-open')).toBeNull()
    expect(container.querySelectorAll('img.tool-row__image')).toHaveLength(1)
  })
})
