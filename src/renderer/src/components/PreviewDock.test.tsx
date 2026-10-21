import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
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
    // The whole URL, scheme included: what shows is what the arrow opens.
    expect(screen.getByText('http://localhost:3000/')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Reload localhost:3000'))
    expect(api.reloadPreviewPane).toHaveBeenCalledWith('server:a')

    fireEvent.click(screen.getByLabelText('Open localhost:3000 in browser'))
    expect(api.openPreviewExternal).toHaveBeenCalledWith('http://localhost:3000/')
  })

  it('opens and copies the full URL, scheme included', async () => {
    // Only the clipboard is swapped, and only for this test: replacing the whole
    // navigator (or unstubbing every global after it) also pulls the ResizeObserver
    // stub out from under a dock that is still mounted.
    const writeText = vi.fn(() => Promise.resolve())
    const had = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    onTestFinished(() => {
      if (had) Object.defineProperty(navigator, 'clipboard', had)
      else delete (navigator as { clipboard?: unknown }).clipboard
    })
    renderDock({ servers: [running('a', 'http://localhost:5175/')] })
    fireEvent.click(screen.getByLabelText('Open localhost:5175 in browser'))
    expect(api.openPreviewExternal).toHaveBeenCalledWith('http://localhost:5175/')
    // Whatever the pane holds, the external open is always an absolute http(s) URL.
    const [opened] = api.openPreviewExternal.mock.calls[0] as unknown as [string]
    expect(opened).toMatch(/^https?:\/\//)
    fireEvent.click(screen.getByLabelText('Copy http://localhost:5175/'))
    expect(writeText).toHaveBeenCalledWith('http://localhost:5175/')
    expect(await screen.findByLabelText('Copied http://localhost:5175/')).toBeInTheDocument()
  })

  it('lets a server that printed several URLs switch between them, starting on the Local: one', () => {
    const server: PreviewServer = {
      id: 'a',
      command: 'npm run dev',
      running: true,
      url: 'http://localhost:5175/',
      urls: ['http://localhost:5175/', 'http://localhost:3001/']
    }
    renderDock({ servers: [server] })
    const picker = screen.getByLabelText('Address shown for npm run dev') as HTMLSelectElement
    expect(picker.value).toBe('http://localhost:5175/')
    expect([...picker.options].map((o) => o.value)).toEqual(['http://localhost:5175/', 'http://localhost:3001/'])
    fireEvent.change(picker, { target: { value: 'http://localhost:3001/' } })
    const specs = api.syncPreviewPanes.mock.calls.at(-1)?.[0] as Array<{ id: string; url: string }>
    expect(specs).toEqual([expect.objectContaining({ id: 'server:a', url: 'http://localhost:3001/' })])
    fireEvent.click(screen.getByLabelText('Open localhost:3001 in browser'))
    expect(api.openPreviewExternal).toHaveBeenCalledWith('http://localhost:3001/')
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

    expect(screen.getByText('http://localhost:4321/')).toBeInTheDocument()
    const bar = screen.getByText('http://localhost:4321/').closest('.preview-pane__bar') as HTMLElement
    fireEvent.click(within(bar).getByLabelText('Remove localhost:4321'))
    expect(screen.queryByText('http://localhost:4321/')).not.toBeInTheDocument()
  })

  it('closes one server pane without touching the other, and shows it again on request', () => {
    const servers = [running('a', 'http://localhost:3001/'), running('b', 'http://localhost:3002/')]
    renderDock({ servers })

    fireEvent.click(screen.getByLabelText('Close preview of localhost:3002'))
    expect(screen.queryByText('http://localhost:3002/')).not.toBeInTheDocument()
    expect(screen.getByText('http://localhost:3001/')).toBeInTheDocument()
    expect(api.syncPreviewPanes.mock.calls.at(-1)![0].map((p: { id: string }) => p.id)).toEqual(['server:a'])
    expect(screen.getByText(/1 preview closed/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Show it' }))
    expect(screen.getByText('http://localhost:3002/')).toBeInTheDocument()
    expect(screen.queryByText(/preview closed/)).not.toBeInTheDocument()
  })

  it('frees a closed pane\'s slot for a server past the cap', () => {
    const servers = ['a', 'b', 'c', 'd'].map((id, i) => running(id, `http://localhost:300${i}/`))
    renderDock({ servers })
    fireEvent.click(screen.getByLabelText('Close preview of localhost:3000'))
    expect(screen.getByText('http://localhost:3003/')).toBeInTheDocument()
    expect(screen.queryByText(/more not shown/)).not.toBeInTheDocument()
  })

  it('says the servers still run when every pane is closed', () => {
    renderDock({ servers: [running('a', 'http://localhost:3001/')] })
    fireEvent.click(screen.getByLabelText('Close preview of localhost:3001'))
    expect(screen.getByText(/All previews are closed/)).toBeInTheDocument()
    expect(screen.queryByText('No running dev servers.')).not.toBeInTheDocument()
  })

  it('reopens a closed pane when Tasks asks to preview its server', () => {
    const servers = [running('a', 'http://localhost:3001/')]
    const { rerender } = renderDock({ servers })
    fireEvent.click(screen.getByLabelText('Close preview of localhost:3001'))
    rerender(
      <PreviewDock
        servers={servers}
        occluded={false}
        onResizeMouseDown={noop}
        onClose={vi.fn()}
        focusServerId="a"
        focusRequest={{ id: 'a' }}
      />
    )
    expect(screen.getByText('http://localhost:3001/')).toBeInTheDocument()

    // Closed again, then a second "Open preview" for the same server: a new request object.
    fireEvent.click(screen.getByLabelText('Close preview of localhost:3001'))
    rerender(
      <PreviewDock
        servers={servers}
        occluded={false}
        onResizeMouseDown={noop}
        onClose={vi.fn()}
        focusServerId="a"
        focusRequest={{ id: 'a' }}
      />
    )
    expect(screen.getByText('http://localhost:3001/')).toBeInTheDocument()
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

describe('PreviewDock tabs (Preview | Tasks)', () => {
  function renderTabbed(tab: 'preview' | 'tasks', onTabChange = vi.fn(), servers: PreviewServer[] = []) {
    const utils = render(
      <PreviewDock
        servers={servers}
        occluded={false}
        onResizeMouseDown={noop}
        onClose={vi.fn()}
        tab={tab}
        onTabChange={onTabChange}
        taskCount={2}
        tasks={<p>tasks content</p>}
      />
    )
    return { ...utils, onTabChange }
  }

  it('has no tab strip when used Preview-only', () => {
    renderDock()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByLabelText('Hide preview panel')).toBeInTheDocument()
  })

  it('shows the Preview tab selected with the Tasks tab carrying the live count', () => {
    renderTabbed('preview')
    const preview = screen.getByRole('tab', { name: 'Preview' })
    const tasks = screen.getByRole('tab', { name: /Tasks/ })
    expect(preview).toHaveAttribute('aria-selected', 'true')
    expect(tasks).toHaveAttribute('aria-selected', 'false')
    expect(within(tasks).getByLabelText('2 running')).toHaveTextContent('2')
    expect(screen.getByRole('tabpanel', { name: 'Preview' })).toBeVisible()
    expect(screen.getByText('tasks content')).not.toBeVisible()
  })

  it('switches tabs on click and with the arrow keys', () => {
    const { onTabChange } = renderTabbed('preview')
    fireEvent.click(screen.getByRole('tab', { name: /Tasks/ }))
    expect(onTabChange).toHaveBeenLastCalledWith('tasks')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Preview' }), { key: 'ArrowRight' })
    expect(onTabChange).toHaveBeenLastCalledWith('tasks')
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Preview' }), { key: 'End' })
    expect(onTabChange).toHaveBeenLastCalledWith('tasks')
  })

  it('keeps Preview mounted but hides its native pages while Tasks shows', () => {
    renderTabbed('tasks', vi.fn(), [running('a', 'http://localhost:3000/')])
    expect(screen.getByText('tasks content')).toBeVisible()
    // The pane's DOM survives (added URLs and choices are kept) …
    expect(screen.getByText('http://localhost:3000/')).toBeInTheDocument()
    // … but main is told not to paint the native view over the Tasks list.
    expect(api.syncPreviewPanes).toHaveBeenLastCalledWith(expect.any(Array), false)
  })

  it('labels the close button for the whole panel', () => {
    renderTabbed('preview')
    expect(screen.getByLabelText('Hide side panel')).toBeInTheDocument()
  })
})

describe('PreviewDock pane labels', () => {
  it('labels a server pane by the command that runs it, with the full command on hover', () => {
    const cmd = 'cd /w/app/web && source venv/bin/activate && python manage.py runserver > /tmp/log 2>&1'
    renderDock({ servers: [{ id: 'a', command: cmd, running: true, url: 'http://localhost:8000/' }] })
    const label = screen.getByText('python manage.py runserver')
    expect(label).toHaveAttribute('title', cmd)
  })
})
