import { beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Notification that records what was shown, and a fake shell.openExternal.
const h = vi.hoisted(() => ({
  supported: true,
  shown: [] as { title: string; body: string }[],
  opened: [] as string[]
}))
vi.mock('electron', () => ({
  Notification: class {
    constructor(private opts: { title: string; body: string }) {}
    static isSupported(): boolean {
      return h.supported
    }
    on(): void {}
    show(): void {
      h.shown.push(this.opts)
    }
  },
  shell: {
    openExternal: async (url: string): Promise<void> => {
      h.opened.push(url)
    }
  }
}))

const { notificationSettingsUrl, notifyAgentEvent, openNotificationSettings, sendTestNotification } =
  await import('./notifications')

beforeEach(() => {
  h.supported = true
  h.shown.length = 0
  h.opened.length = 0
})

describe('sendTestNotification', () => {
  it('shows a notification even while Houston is focused', () => {
    // An agent event is held back while the window is focused...
    notifyAgentEvent(
      { runId: 'r', type: 'done', stopReason: 'end_turn' },
      { isDestroyed: () => false, isFocused: () => true } as unknown as Electron.BrowserWindow,
      { enabled: true }
    )
    expect(h.shown).toHaveLength(0)
    // ...but the test is shown right away, so the OS permission prompt appears now.
    expect(sendTestNotification()).toBe(true)
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0].title).toBe('Houston')
  })

  it('reports when the platform cannot show notifications', () => {
    h.supported = false
    expect(sendTestNotification()).toBe(false)
    expect(h.shown).toHaveLength(0)
  })
})

describe('notificationSettingsUrl', () => {
  it('points at the macOS and Windows notification pages', () => {
    expect(notificationSettingsUrl('darwin')).toBe(
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    )
    expect(notificationSettingsUrl('win32')).toBe('ms-settings:notifications')
  })

  it('has no page on Linux', () => {
    expect(notificationSettingsUrl('linux')).toBeNull()
  })
})

describe('openNotificationSettings', () => {
  it('opens the page for this platform, or nothing where there is none', async () => {
    const expected = notificationSettingsUrl()
    expect(await openNotificationSettings()).toBe(expected !== null)
    expect(h.opened).toEqual(expected ? [expected] : [])
  })
})
