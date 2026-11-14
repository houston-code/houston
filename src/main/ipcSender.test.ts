import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null } }))
vi.mock('./logger', () => ({ log: { warn: vi.fn() } }))

import {
  UNTRUSTED_SENDER_ERROR,
  configureIpcSenderPolicy,
  guardIpcHandle,
  guardIpcOn,
  isAppDocumentUrl,
  isTrustedIpcEvent,
  type FrameLike
} from './ipcSender'
import { registerAppWindow } from './windows'

const START = 'file:///Applications/Houston.app/Contents/Resources/app.asar/out/renderer/index.html'

/** A fake chat window: a BrowserWindow-shaped emitter whose webContents has a main frame. */
let nextId = 1
function chatWindow(url = START) {
  const id = nextId++
  const win = Object.assign(new EventEmitter(), {
    id,
    destroyed: false,
    isDestroyed(): boolean {
      return this.destroyed
    },
    webContents: { id: 100 + id, mainFrame: { url, parent: null, processId: 7, routingId: id } as FrameLike }
  })
  return win
}

const eventFrom = (wc: { mainFrame: FrameLike }, frame: FrameLike | null = wc.mainFrame) => ({ sender: wc, senderFrame: frame })

describe('isAppDocumentUrl', () => {
  it('accepts the start document, with a route or query, and the dev origin', () => {
    expect(isAppDocumentUrl(START, START)).toBe(true)
    expect(isAppDocumentUrl(`${START}#/chat/1`, START)).toBe(true)
    expect(isAppDocumentUrl(`${START}?x=1`, START)).toBe(true)
    expect(isAppDocumentUrl('http://localhost:5173/settings', 'http://localhost:5173', 'http://localhost:5173')).toBe(true)
  })

  it('accepts a different spelling of the same file', () => {
    const start = 'file:///C:/Program%20Files/Houston/resources/app.asar/out/renderer/index.html'
    const frame = 'file:///C:/Program Files/Houston/resources/app.asar/out/renderer/index.html'
    expect(isAppDocumentUrl(frame, start)).toBe(true)
  })

  it('refuses any other document', () => {
    expect(isAppDocumentUrl('file:///tmp/evil.html', START)).toBe(false)
    expect(isAppDocumentUrl('https://attacker.example/', START)).toBe(false)
    expect(isAppDocumentUrl('http://localhost:5174/', 'http://localhost:5173', 'http://localhost:5173')).toBe(false)
    expect(isAppDocumentUrl('', START)).toBe(false)
    expect(isAppDocumentUrl('about:blank', START)).toBe(false)
  })
})

describe('isTrustedIpcEvent', () => {
  it('trusts nothing before the policy is configured', () => {
    const win = chatWindow()
    registerAppWindow(win as never)
    expect(isTrustedIpcEvent(eventFrom(win.webContents), null)).toBe(false)
  })

  it('trusts only the main frame of a registered, open chat window showing the app', () => {
    configureIpcSenderPolicy({ startUrl: START })
    const win = chatWindow()
    registerAppWindow(win as never)
    const wc = win.webContents
    expect(isTrustedIpcEvent(eventFrom(wc))).toBe(true)
    // The same frame reported as a fresh object (Electron may hand out a new wrapper).
    expect(isTrustedIpcEvent(eventFrom(wc, { ...wc.mainFrame }))).toBe(true)

    // A subframe, a frame of another page, a missing frame.
    expect(isTrustedIpcEvent(eventFrom(wc, { url: START, parent: wc.mainFrame }))).toBe(false)
    expect(isTrustedIpcEvent(eventFrom(wc, { url: START, parent: null, processId: 7, routingId: 999 }))).toBe(false)
    expect(isTrustedIpcEvent(eventFrom(wc, null))).toBe(false)

    // The window navigated away from the app's document.
    wc.mainFrame.url = 'https://attacker.example/'
    expect(isTrustedIpcEvent(eventFrom(wc))).toBe(false)
    wc.mainFrame.url = START

    // Closed: no longer a chat window.
    win.destroyed = true
    win.emit('closed')
    expect(isTrustedIpcEvent(eventFrom(wc))).toBe(false)
  })

  it('refuses a webContents no chat window owns (a helper window, a preview pane)', () => {
    configureIpcSenderPolicy({ startUrl: START })
    const stray = chatWindow().webContents
    expect(isTrustedIpcEvent(eventFrom(stray))).toBe(false)
    expect(isTrustedIpcEvent({})).toBe(false)
    expect(isTrustedIpcEvent(null)).toBe(false)
    expect(isTrustedIpcEvent({ sender: {} })).toBe(false)
  })

  it('refuses when reading the frame throws (a frame that is gone)', () => {
    configureIpcSenderPolicy({ startUrl: START })
    const win = chatWindow()
    registerAppWindow(win as never)
    const event = {
      sender: win.webContents,
      get senderFrame(): FrameLike {
        throw new Error('Render frame was disposed')
      }
    }
    expect(isTrustedIpcEvent(event)).toBe(false)
  })
})

describe('guardIpcHandle and guardIpcOn', () => {
  it('rejects an untrusted invoke without running the handler', async () => {
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const handle = guardIpcHandle(((ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      registered.set(ch, fn)
    }) as never, (e) => (e as { ok?: boolean }).ok === true)
    const listener = vi.fn(() => 'ran')
    handle('x', listener)
    expect(() => registered.get('x')!({ ok: false }, 1)).toThrow(UNTRUSTED_SENDER_ERROR)
    expect(listener).not.toHaveBeenCalled()
    expect(registered.get('x')!({ ok: true }, 1)).toBe('ran')
    expect(listener).toHaveBeenCalledWith({ ok: true }, 1)
  })

  it('drops an untrusted message without running the listener', () => {
    const registered = new Map<string, (event: unknown, ...args: unknown[]) => void>()
    const on = guardIpcOn(((ch: string, fn: (event: unknown, ...args: unknown[]) => void) => {
      registered.set(ch, fn)
    }) as never, (e) => (e as { ok?: boolean }).ok === true)
    const listener = vi.fn()
    on('y', listener)
    registered.get('y')!({ ok: false }, 'a')
    expect(listener).not.toHaveBeenCalled()
    registered.get('y')!({ ok: true }, 'a')
    expect(listener).toHaveBeenCalledWith({ ok: true }, 'a')
  })
})
