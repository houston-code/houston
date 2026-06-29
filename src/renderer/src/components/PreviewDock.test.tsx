import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PreviewServer } from '@shared/preview'
import { PreviewDock } from './PreviewDock'

class FakeResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const api = {
  syncPreviewPanes: vi.fn(),
  reloadPreviewPane: vi.fn(),
  openPreviewExternal: vi.fn(() => Promise.resolve())
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  window.api = api as unknown as typeof window.api
})

const noop = (): void => {}

function renderDock(props: Partial<React.ComponentProps<typeof PreviewDock>> = {}) {
  return render(
    <PreviewDock servers={[]} occluded={false} onResizeMouseDown={noop} onClose={vi.fn()} {...props} />
  )
}

const running = (id: string, url?: string): PreviewServer => ({
  id,
  command: 'npm run dev',
  running: true,
  ...(url ? { url } : {})
})

describe('PreviewDock', () => {
  it('shows the empty state when there are no running servers', () => {
    renderDock()
    expect(screen.getByText('No running dev servers.')).toBeInTheDocument()
  })

  it('shows a "waiting" state for a running server with no URL yet', () => {
    renderDock({ servers: [running('a')] })
    expect(screen.getByText(/Waiting for a server to report its URL/)).toBeInTheDocument()
  })

  it('renders a pane for a server that reported a URL, with working actions', () => {
    renderDock({ servers: [running('a', 'http://localhost:3000/')] })
    expect(screen.getByText('npm run dev')).toBeInTheDocument()
    expect(screen.getByText('localhost:3000')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Reload localhost:3000'))
    expect(api.reloadPreviewPane).toHaveBeenCalledWith('server:a')

    fireEvent.click(screen.getByLabelText('Open localhost:3000 in browser'))
    expect(api.openPreviewExternal).toHaveBeenCalledWith('http://localhost:3000/')
  })

  it('positions the native views via syncPreviewPanes, hidden while occluded', () => {
    const { rerender } = renderDock({ servers: [running('a', 'http://localhost:3000/')] })
    // Last call while visible: the pane spec is present and visible=true.
    const visibleCall = api.syncPreviewPanes.mock.calls.at(-1)!
    expect(visibleCall[0]).toHaveLength(1)
    expect(visibleCall[1]).toBe(true)

    rerender(
      <PreviewDock
        servers={[running('a', 'http://localhost:3000/')]}
        occluded={true}
        onResizeMouseDown={noop}
        onClose={vi.fn()}
      />
    )
    // While occluded the views are kept but hidden.
    expect(api.syncPreviewPanes.mock.calls.at(-1)![1]).toBe(false)
  })

  it('adds a manual URL from a bare port and lets it be removed', () => {
    renderDock()
    const input = screen.getByLabelText('Add a localhost URL to preview')
    fireEvent.change(input, { target: { value: '4321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(screen.getByText('localhost:4321')).toBeInTheDocument()
    const bar = screen.getByText('localhost:4321').closest('.preview-pane__bar') as HTMLElement
    fireEvent.click(within(bar).getByLabelText('Remove localhost:4321'))
    expect(screen.queryByText('localhost:4321')).not.toBeInTheDocument()
  })

  it('flags an invalid manual URL instead of adding it', () => {
    renderDock()
    const input = screen.getByLabelText('Add a localhost URL to preview')
    fireEvent.change(input, { target: { value: 'https://example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('No running dev servers.')).toBeInTheDocument() // nothing added
  })

  it('notes how many previewable sources are hidden by the cap', () => {
    const servers = ['a', 'b', 'c', 'd'].map((id, i) => running(id, `http://localhost:300${i}/`))
    renderDock({ servers })
    expect(screen.getByText(/\+1 more not shown \(max 3\)/)).toBeInTheDocument()
  })
})
