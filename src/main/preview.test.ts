import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseWindow } from 'electron'
import type { PreviewPaneSpec } from '@shared/preview'

const h = vi.hoisted(() => ({ views: [] as Array<{ visible: boolean; loaded: string[]; closed: boolean }> }))

vi.mock('electron', () => {
  class WebContentsView {
    private readonly rec = { visible: true, loaded: [] as string[], closed: false }
    webContents = {
      on: (): void => {},
      setWindowOpenHandler: (): void => {},
      loadURL: (url: string): Promise<void> => {
        this.rec.loaded.push(url)
        return Promise.resolve()
      },
      isDestroyed: (): boolean => this.rec.closed,
      close: (): void => {
        this.rec.closed = true
      }
    }
    constructor() {
      h.views.push(this.rec)
    }
    setVisible(v: boolean): void {
      this.rec.visible = v
    }
    setBounds(): void {}
  }
  return { WebContentsView, session: { fromPartition: () => ({}) } }
})
vi.mock('./hardenedSession', () => ({ hardenUntrustedSession: vi.fn() }))

const spec = (id: string, port = 5173): PreviewPaneSpec => ({
  id,
  url: `http://localhost:${port}/`,
  bounds: { x: 0, y: 0, width: 400, height: 300 }
})

function fakeWindow(): BaseWindow & { children: number } {
  const win = {
    children: 0,
    isDestroyed: () => false,
    contentView: {
      addChildView: () => {
        win.children++
      },
      removeChildView: () => {
        win.children--
      }
    }
  }
  return win as unknown as BaseWindow & { children: number }
}

const host = fakeWindow()

async function load(): Promise<typeof import('./preview')> {
  vi.resetModules()
  h.views.length = 0
  return import('./preview')
}

describe('syncPreviewPanes', () => {
  beforeEach(() => {
    h.views.length = 0
  })

  it('does not start a pane while the dock cannot be seen', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes(host, [spec('a'), spec('b', 3000)], false)
    expect(h.views).toHaveLength(0)
  })

  it('starts the panes on the first visible sync', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes(host, [spec('a')], false)
    syncPreviewPanes(host, [spec('a')], true)
    expect(h.views).toHaveLength(1)
    expect(h.views[0].loaded).toEqual(['http://localhost:5173/'])
    expect(h.views[0].visible).toBe(true)
  })

  it('keeps a pane that already exists when it is hidden, without reloading it', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes(host, [spec('a')], true)
    syncPreviewPanes(host, [spec('a')], false)
    expect(h.views).toHaveLength(1)
    expect(h.views[0].visible).toBe(false)
    expect(h.views[0].closed).toBe(false)
    syncPreviewPanes(host, [spec('a')], true)
    expect(h.views).toHaveLength(1)
    expect(h.views[0].loaded).toHaveLength(1)
    expect(h.views[0].visible).toBe(true)
  })

  it('never loads a URL that is not on loopback, visible or not', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes(host, [{ ...spec('a'), url: 'https://example.com/' }], true)
    expect(h.views).toHaveLength(0)
  })

  it("keeps each window's panes separate, and tears down only the closing window's", async () => {
    const { syncPreviewPanes, destroyPreviewPanesOf, reloadPreviewPane } = await load()
    const a = fakeWindow()
    const b = fakeWindow()
    syncPreviewPanes(a, [spec('a')], true)
    syncPreviewPanes(b, [spec('a')], true)
    expect(h.views).toHaveLength(2)
    expect(a.children).toBe(1)
    expect(b.children).toBe(1)
    // An empty sync from one window leaves the other's pane alone.
    syncPreviewPanes(b, [], false)
    expect(h.views[0].closed).toBe(false)
    expect(h.views[1].closed).toBe(true)
    destroyPreviewPanesOf(a)
    expect(h.views[0].closed).toBe(true)
    expect(a.children).toBe(0)
    // A reload for a pane the window doesn't have is a no-op.
    expect(() => reloadPreviewPane(a, 'a')).not.toThrow()
  })

  it('ignores a sync with no window', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes(null, [spec('a')], true)
    expect(h.views).toHaveLength(0)
  })
})
