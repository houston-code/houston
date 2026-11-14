import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { IPC } from '@shared/constants'

const h = vi.hoisted(() => ({
  ipc: new Map<string, (event: unknown) => void>(),
  appWindows: [] as unknown[],
  target: undefined as unknown,
  sent: [] as Array<{ win: number; channel: string; args: unknown[] }>
}))

vi.mock('electron', () => ({
  app: { on: () => {}, isReady: () => true, isPackaged: false },
  dialog: { showMessageBox: async () => ({ response: 1 }) },
  ipcMain: { on: (channel: string, fn: (event: unknown) => void) => h.ipc.set(channel, fn) }
}))
vi.mock('./helperWindows', () => ({ appWindows: () => h.appWindows }))
vi.mock('./windows', () => ({ targetWindow: () => h.target, windowShowing: () => undefined }))
vi.mock('./store', () => ({ getSettings: () => ({ recentWorkspaces: [] }), rememberWorkspace: () => {} }))
vi.mock('./conversations', () => ({ conversationExists: () => true, listConversations: () => [] }))
vi.mock('./logger', () => ({ log: { info: () => {} } }))

/** A fake chat window whose renderer is an event emitter. */
function fakeWindow(id: number) {
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => h.sent.push({ win: id, channel, args })
  })
  return {
    id,
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => {}
  }
}

async function load(): Promise<typeof import('./deepLinkHost')> {
  vi.resetModules()
  h.ipc.clear()
  h.sent.length = 0
  return import('./deepLinkHost')
}

const ready = (win: ReturnType<typeof fakeWindow>): void => h.ipc.get(IPC.deepLinkReady)!({ sender: win.webContents })
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('deep link host', () => {
  beforeEach(() => {
    h.appWindows = []
    h.target = undefined
  })

  it('sends a link to the window app-level actions land on, not the oldest one', async () => {
    const { wireDeepLinks } = await load()
    const oldest = fakeWindow(1)
    const recent = fakeWindow(2)
    h.appWindows = [oldest, recent]
    // A browser has focus; the most recently used chat window is the target.
    h.target = recent
    const router = wireDeepLinks({ started: Promise.resolve(), createWindow: () => {} })
    ready(recent)
    await flush()
    await router.handle('houston://settings')
    expect(h.sent.map((s) => s.win)).toEqual([2])
  })

  it('watches each renderer once, however many times its page says ready', async () => {
    const { wireDeepLinks } = await load()
    const win = fakeWindow(1)
    h.appWindows = [win]
    h.target = win
    wireDeepLinks({ started: Promise.resolve(), createWindow: () => {} })
    for (let i = 0; i < 5; i++) ready(win)
    expect(win.webContents.listenerCount('destroyed')).toBe(1)
    expect(win.webContents.listenerCount('did-start-navigation')).toBe(1)
  })

  it('holds a link that arrives mid-reload until the new page is ready', async () => {
    const { wireDeepLinks } = await load()
    const win = fakeWindow(1)
    h.appWindows = [win]
    h.target = win
    const router = wireDeepLinks({ started: Promise.resolve(), createWindow: () => {} })
    ready(win)
    await flush()

    // An in-page navigation or a subframe load is not a reload.
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    win.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    await router.handle('houston://settings')
    expect(h.sent).toHaveLength(1)

    // The reload starts: the old page's listeners are going away.
    win.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await router.handle('houston://settings')
    expect(h.sent).toHaveLength(1)

    // The new page attaches its listeners and says so; the held link goes to it.
    ready(win)
    await flush()
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1].channel).toBe(IPC.menuOpenSettings)
  })
})
