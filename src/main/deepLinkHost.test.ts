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
vi.mock('./logger', () => ({ log: { info: () => {}, warn: () => {} } }))

/** A fake chat window whose renderer is an event emitter. */
function fakeWindow(id: number) {
  const webContents = Object.assign(new EventEmitter(), {
    // The page's main frame, showing the app's own document (the IPC sender check).
    mainFrame: { url: APP_URL, parent: null },
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

const APP_URL = 'file:///app/out/renderer/index.html'

async function load(): Promise<typeof import('./deepLinkHost')> {
  vi.resetModules()
  h.ipc.clear()
  h.sent.length = 0
  const mod = await import('./deepLinkHost')
  // The sender check treats the fake app windows as the registered chat windows.
  const { configureIpcSenderPolicy } = await import('./ipcSender')
  configureIpcSenderPolicy({
    startUrl: APP_URL,
    isAppContents: (wc) => (h.appWindows as { webContents: unknown }[]).some((w) => w.webContents === wc)
  })
  return mod
}

const ready = (win: ReturnType<typeof fakeWindow>): void =>
  h.ipc.get(IPC.deepLinkReady)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
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

  it('keeps delivering to a listening window when another one reloads and closes', async () => {
    const { wireDeepLinks } = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    h.appWindows = [a, b]
    h.target = b
    const router = wireDeepLinks({ started: Promise.resolve(), createWindow: () => {} })
    ready(a)
    ready(b)
    await flush()
    // B starts reloading, then closes before its new page says ready.
    b.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    b.webContents.emit('destroyed')
    h.appWindows = [a]
    h.target = a
    await router.handle('houston://settings')
    expect(h.sent.map((s) => s.win)).toEqual([1])
  })

  it('sends to a listening window rather than the target while the target reloads', async () => {
    const { wireDeepLinks } = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    h.appWindows = [a, b]
    h.target = b
    const router = wireDeepLinks({ started: Promise.resolve(), createWindow: () => {} })
    ready(a)
    ready(b)
    await flush()
    b.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await router.handle('houston://settings')
    expect(h.sent.map((s) => s.win)).toEqual([1])
    // Once B's new page is listening, it gets links again.
    ready(b)
    await flush()
    await router.handle('houston://settings')
    expect(h.sent.map((s) => s.win)).toEqual([1, 2])
  })
})

describe('deepLinkReady sender check', () => {
  it('ignores ready from a subframe or a page that is not the app', async () => {
    const { wireDeepLinks } = await load()
    const win = fakeWindow(1)
    h.appWindows = [win]
    h.target = win
    const router = wireDeepLinks({ started: Promise.resolve(), createWindow: () => {} })
    const hello = h.ipc.get(IPC.deepLinkReady)!
    hello({ sender: win.webContents, senderFrame: { url: APP_URL, parent: win.webContents.mainFrame } })
    win.webContents.mainFrame = { url: 'https://attacker.example/', parent: null }
    hello({ sender: win.webContents, senderFrame: win.webContents.mainFrame })
    await flush()
    await router.handle('houston://settings')
    // Still held: no ready was accepted, so nothing reached the window.
    expect(h.sent).toEqual([])
    expect(win.webContents.listenerCount('destroyed')).toBe(0)
  })
})

describe('resolvesToNetworkPath', () => {
  it('flags a share or device as Windows resolves it, including a /x against a share cwd', async () => {
    const { resolvesToNetworkPath } = await load()
    expect(resolvesToNetworkPath('\\\\host\\share', 'win32', 'C:\\Users\\me')).toBe(true)
    expect(resolvesToNetworkPath('/\\host\\share', 'win32', 'C:\\Users\\me')).toBe(true)
    expect(resolvesToNetworkPath('\\\\?\\UNC\\h\\s', 'win32', 'C:\\Users\\me')).toBe(true)
    expect(resolvesToNetworkPath('/repo', 'win32', '\\\\srv\\share\\dir')).toBe(true)
    expect(resolvesToNetworkPath('/repo', 'win32', 'C:\\Users\\me')).toBe(false)
    expect(resolvesToNetworkPath('C:\\repo', 'win32', '\\\\srv\\share')).toBe(false)
    // POSIX has no shares in its path syntax.
    expect(resolvesToNetworkPath('//host/share', 'darwin', '/')).toBe(false)
  })

  it('makes resolveDirectory refuse a share without touching it', async () => {
    const { resolveDirectory } = await load()
    if (process.platform === 'win32') expect(resolveDirectory('\\\\host\\share')).toBeNull()
    expect(resolveDirectory(process.cwd())).not.toBeNull()
  })
})
