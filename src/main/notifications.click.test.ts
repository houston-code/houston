import { describe, expect, it, vi } from 'vitest'
import { IPC } from '@shared/constants'

// A fake Notification that records its click handler, so the test can click it.
const h = vi.hoisted(() => ({ clicks: [] as (() => void)[] }))
vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    on(event: string, fn: () => void): void {
      if (event === 'click') h.clicks.push(fn)
    }
    show(): void {}
  }
}))

const { notifyAgentEvent } = await import('./notifications')

function fakeWindow() {
  return {
    isDestroyed: () => false,
    isFocused: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { isDestroyed: () => false, send: vi.fn() }
  }
}

describe('notification click', () => {
  it('brings the window forward and opens the chat the notification is about', () => {
    const win = fakeWindow()
    notifyAgentEvent(
      { runId: 'r', type: 'done', stopReason: 'end_turn' },
      win as unknown as Electron.BrowserWindow,
      { enabled: true, conversationId: 'conv-1' }
    )
    h.clicks.at(-1)!()
    expect(win.focus).toHaveBeenCalled()
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.chatOpenRequest, 'conv-1')
  })

  it('only focuses when it is not about a particular chat', () => {
    const win = fakeWindow()
    notifyAgentEvent(
      { runId: 'r', type: 'done', stopReason: 'end_turn' },
      win as unknown as Electron.BrowserWindow,
      { enabled: true }
    )
    h.clicks.at(-1)!()
    expect(win.focus).toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
