import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ focused: null as unknown }))
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => h.focused } }))

type Listener = () => void
function fakeWindow(id: number) {
  const listeners: Record<string, Listener[]> = {}
  const w = {
    id,
    destroyed: false,
    focused: false,
    isDestroyed: () => w.destroyed,
    isFocused: () => w.focused,
    on: (ev: string, fn: Listener) => {
      ;(listeners[ev] ??= []).push(fn)
    },
    emit: (ev: string) => listeners[ev]?.forEach((fn) => fn()),
    webContents: { id: id + 100, isDestroyed: () => w.destroyed, send: vi.fn() }
  }
  return w
}

async function load(): Promise<typeof import('./windows')> {
  vi.resetModules()
  return import('./windows')
}

describe('chat windows', () => {
  beforeEach(() => {
    h.focused = null
  })

  it('registers windows, drops them on close, and keeps the first as primary', async () => {
    const m = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    m.registerAppWindow(a as never)
    m.registerAppWindow(b as never)
    expect(m.chatWindows()).toEqual([a, b])
    expect(m.isPrimaryWindow(a as never)).toBe(true)
    expect(m.isPrimaryWindow(b as never)).toBe(false)
    a.destroyed = true
    a.emit('closed')
    expect(m.chatWindows()).toEqual([b])
    expect(m.isPrimaryWindow(b as never)).toBe(true)
  })

  it('targets the focused window, then the last focused one', async () => {
    const m = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    m.registerAppWindow(a as never)
    m.registerAppWindow(b as never)
    a.emit('focus')
    expect(m.targetWindow()).toBe(a)
    h.focused = b
    expect(m.targetWindow()).toBe(b)
    h.focused = null
    expect(m.targetWindow()).toBe(a)
    expect(m.anyChatWindowFocused()).toBe(false)
    b.focused = true
    expect(m.anyChatWindowFocused()).toBe(true)
  })

  it('falls back to the focused window before any chat window is registered', async () => {
    const m = await load()
    const loose = fakeWindow(7)
    h.focused = loose
    expect(m.targetWindow()).toBe(loose)
    h.focused = null
    expect(m.targetWindow()).toBeUndefined()
  })

  it('finds the window showing a chat from its renderer report, and broadcasts to every window', async () => {
    const m = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    m.registerAppWindow(a as never)
    m.registerAppWindow(b as never)
    m.setWindowShowing(102, 'conv-1')
    m.setWindowShowing(999, 'conv-1')
    expect(m.windowShowing('conv-1')).toBe(b)
    expect(m.windowShowing('conv-2')).toBeUndefined()
    m.sendToChatWindows('ch', 1)
    expect(a.webContents.send).toHaveBeenCalledWith('ch', 1)
    expect(b.webContents.send).toHaveBeenCalledWith('ch', 1)
  })
})

describe('opening chat windows', () => {
  it('opens a new window on the requested chat, handing the chat to its renderer once', async () => {
    const m = await load()
    const made: ReturnType<typeof fakeWindow>[] = []
    m.setWindowOpener(() => {
      const w = fakeWindow(10 + made.length)
      ;(w.webContents as unknown as { once: () => void }).once = () => {}
      made.push(w)
      m.registerAppWindow(w as never)
      return w as never
    })
    expect(m.openChatWindow('conv-1')).toBe(made[0])
    expect(m.takeLaunchRequest(110)).toEqual({ conversationId: 'conv-1' })
    expect(m.takeLaunchRequest(110)).toBeUndefined()
    m.openChatWindow(null)
    expect(m.takeLaunchRequest(111)).toEqual({ conversationId: null })
    // The launch window was never given a request.
    expect(m.takeLaunchRequest(999)).toBeUndefined()
  })

  it('brings forward a window already showing the chat instead of opening another', async () => {
    const m = await load()
    const a = Object.assign(fakeWindow(1), { isMinimized: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() })
    m.registerAppWindow(a as never)
    m.setWindowShowing(101, 'conv-1')
    const open = vi.fn()
    m.setWindowOpener(open)
    expect(m.openChatWindow('conv-1')).toBe(a)
    expect(a.restore).toHaveBeenCalled()
    expect(a.focus).toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(m.chatShownBy(101)).toBe('conv-1')
    expect(m.chatShownBy(5)).toBeNull()
  })

  it('opens a second copy when the window asking is the one showing it', async () => {
    const m = await load()
    const a = fakeWindow(1)
    m.registerAppWindow(a as never)
    m.setWindowShowing(101, 'conv-1')
    const b = Object.assign(fakeWindow(2), {})
    ;(b.webContents as unknown as { once: () => void }).once = () => {}
    m.setWindowOpener(() => b as never)
    expect(m.openChatWindow('conv-1', a as never)).toBe(b)
  })

  it('opens nothing before an opener is installed', async () => {
    const m = await load()
    expect(m.openChatWindow(null)).toBeUndefined()
  })
})
