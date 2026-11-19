import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake Notification with ids, events, and a Notification Center history.
const h = vi.hoisted(() => {
  class FakeNotification {
    static history: FakeNotification[] = []
    static created: FakeNotification[] = []
    id: string
    groupId: string
    opts: Record<string, unknown>
    handlers = new Map<string, (() => void)[]>()
    constructor(opts: { id?: string; groupId?: string } = {}) {
      this.opts = opts
      this.id = opts.id ?? 'random'
      this.groupId = opts.groupId ?? ''
      FakeNotification.created.push(this)
    }
    static isSupported(): boolean {
      return true
    }
    static async getHistory(): Promise<FakeNotification[]> {
      return FakeNotification.history
    }
    on(event: string, fn: () => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    emit(event: string): void {
      for (const fn of this.handlers.get(event) ?? []) fn()
    }
    show(): void {}
  }
  return { FakeNotification, app: { focus: vi.fn() } }
})
vi.mock('electron', () => ({
  app: h.app,
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  Notification: h.FakeNotification,
  shell: {}
}))

const {
  chatIdFromNotificationId,
  chatNotificationId,
  liveNotificationCount,
  notifyAgentEvent,
  restoreNotificationClicks,
  setNotificationChatOpener
} = await import('./notifications')

const CHAT = '0b4f3c2e-8d1a-4c5b-9e7f-1a2b3c4d5e6f'
const OTHER = '9f8e7d6c-5b4a-4321-8fed-cba987654321'
const done = { runId: 'r', type: 'done', stopReason: 'end_turn' } as const
const unfocused = {
  isDestroyed: () => false,
  isFocused: () => false,
  isMinimized: () => false,
  show: vi.fn(),
  focus: vi.fn(),
  webContents: { isDestroyed: () => false, send: vi.fn() }
} as unknown as Electron.BrowserWindow

const originalPlatform = process.platform
const setPlatform = (p: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: p })
}

let opened: string[]
beforeEach(() => {
  opened = []
  setNotificationChatOpener((id) => opened.push(id))
  h.FakeNotification.created = []
  h.FakeNotification.history = []
})
afterEach(() => {
  setPlatform(originalPlatform)
  setNotificationChatOpener(null)
})

const last = (): InstanceType<typeof h.FakeNotification> => h.FakeNotification.created.at(-1)!

describe('chat notification ids', () => {
  it('round-trip the chat they name', () => {
    expect(chatIdFromNotificationId(chatNotificationId(CHAT, 'n1'))).toBe(CHAT)
  })

  it('name no chat for foreign or malformed ids', () => {
    expect(chatIdFromNotificationId('some-other-app-id')).toBeNull()
    expect(chatIdFromNotificationId('houston-chat:not-a-chat:n1')).toBeNull()
    expect(chatIdFromNotificationId('houston-chat:../../etc:n1')).toBeNull()
  })
})

describe('notifyAgentEvent', () => {
  it('tags the notification with its chat and groups it per chat', () => {
    notifyAgentEvent(done, unfocused, { enabled: true, conversationId: CHAT })
    expect(chatIdFromNotificationId(last().id)).toBe(CHAT)
    expect(last().groupId).toBe(`houston-chat:${CHAT}`)
  })

  it('opens its chat through the opener when clicked', () => {
    notifyAgentEvent(done, unfocused, { enabled: true, conversationId: CHAT })
    last().emit('click')
    expect(opened).toEqual([CHAT])
  })

  it('takes focus on macOS when clicked, so Houston comes to the front', () => {
    setPlatform('darwin')
    h.app.focus.mockClear()
    notifyAgentEvent(done, unfocused, { enabled: true, conversationId: CHAT })
    last().emit('click')
    expect(h.app.focus).toHaveBeenCalledWith({ steal: true })
  })

  it('asks to stay on screen until acted on (Windows and Linux)', () => {
    notifyAgentEvent(done, unfocused, { enabled: true, conversationId: CHAT })
    expect(last().opts.timeoutType).toBe('never')
    last().emit('close')
  })

  it('keeps each notification until it is clicked or closed', () => {
    const before = liveNotificationCount()
    notifyAgentEvent(done, unfocused, { enabled: true, conversationId: CHAT })
    const first = last()
    notifyAgentEvent(done, unfocused, { enabled: true, conversationId: OTHER })
    const second = last()
    expect(liveNotificationCount()).toBe(before + 2)
    first.emit('click')
    second.emit('close')
    expect(liveNotificationCount()).toBe(before)
  })

  it('lets the oldest go past the cap', () => {
    for (let i = 0; i < 150; i++) notifyAgentEvent(done, unfocused, { enabled: true, conversationId: CHAT })
    expect(liveNotificationCount()).toBe(100)
    for (const n of h.FakeNotification.created) n.emit('close')
    expect(liveNotificationCount()).toBe(0)
  })
})

describe('restoreNotificationClicks', () => {
  it('re-arms an earlier run’s chat notifications on macOS', async () => {
    setPlatform('darwin')
    const ours = new h.FakeNotification({ id: chatNotificationId(CHAT, 'old') })
    const foreign = new h.FakeNotification({ id: 'not-ours' })
    h.FakeNotification.history = [ours, foreign]
    expect(await restoreNotificationClicks()).toBe(1)
    ours.emit('click')
    foreign.emit('click')
    expect(opened).toEqual([CHAT])
    ours.emit('close')
  })

  it('does nothing on other platforms', async () => {
    setPlatform('win32')
    h.FakeNotification.history = [new h.FakeNotification({ id: chatNotificationId(CHAT, 'old') })]
    expect(await restoreNotificationClicks()).toBe(0)
  })
})
