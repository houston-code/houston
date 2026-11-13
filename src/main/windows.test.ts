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
