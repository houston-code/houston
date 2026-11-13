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

async function load(): Promise<typeof import('./preview')> {
  vi.resetModules()
  h.views.length = 0
  const mod = await import('./preview')
  mod.attachPreviewHost({
    contentView: { addChildView: () => {}, removeChildView: () => {} }
  } as unknown as BaseWindow)
  return mod
}

describe('syncPreviewPanes', () => {
  beforeEach(() => {
    h.views.length = 0
  })

  it('does not start a pane while the dock cannot be seen', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes([spec('a'), spec('b', 3000)], false)
    expect(h.views).toHaveLength(0)
  })

  it('starts the panes on the first visible sync', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes([spec('a')], false)
    syncPreviewPanes([spec('a')], true)
    expect(h.views).toHaveLength(1)
    expect(h.views[0].loaded).toEqual(['http://localhost:5173/'])
    expect(h.views[0].visible).toBe(true)
  })

  it('keeps a pane that already exists when it is hidden, without reloading it', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes([spec('a')], true)
    syncPreviewPanes([spec('a')], false)
    expect(h.views).toHaveLength(1)
    expect(h.views[0].visible).toBe(false)
    expect(h.views[0].closed).toBe(false)
    syncPreviewPanes([spec('a')], true)
    expect(h.views).toHaveLength(1)
    expect(h.views[0].loaded).toHaveLength(1)
    expect(h.views[0].visible).toBe(true)
  })

  it('never loads a URL that is not on loopback, visible or not', async () => {
    const { syncPreviewPanes } = await load()
    syncPreviewPanes([{ ...spec('a'), url: 'https://example.com/' }], true)
    expect(h.views).toHaveLength(0)
  })
})
