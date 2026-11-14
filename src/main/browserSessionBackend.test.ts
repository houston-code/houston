import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Electron backend behind browser_session: each session gets its own in-memory
 * partition carrying exactly the capture session's guards, the same hardened window
 * and loopback pin as view_localhost, an observe-only network log, and a close that
 * leaves nothing stored behind.
 */
const fake = vi.hoisted(() => {
  type Listener = (details: Record<string, unknown>, cb?: (r: { cancel: boolean }) => void) => void
  const state = {
    partitions: [] as { name: string; opts: unknown }[],
    sessions: [] as FakeSession[],
    windows: [] as FakeWindow[]
  }
  class FakeSession {
    listeners = new Map<string, Listener>()
    cleared = 0
    permissionHandler: unknown = null
    downloadHandler: unknown = null
    webRequest = {
      onBeforeRequest: (l: Listener) => this.listeners.set('before', l),
      onSendHeaders: (l: Listener) => this.listeners.set('send', l),
      onCompleted: (l: Listener) => this.listeners.set('completed', l),
      onErrorOccurred: (l: Listener) => this.listeners.set('error', l)
    }
    on(event: string, l: unknown): void {
      if (event === 'will-download') this.downloadHandler = l
    }
    setPermissionRequestHandler(h: unknown): void {
      this.permissionHandler = h
    }
    async clearStorageData(): Promise<void> {
      this.cleared++
    }
  }
  class FakeWebContents {
    handlers = new Map<string, (...args: unknown[]) => void>()
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.handlers.set(event, fn)
      return this
    }
    once(event: string, fn: (...args: unknown[]) => void): this {
      return this.on(event, fn)
    }
    setFrameRate(): void {}
    windowOpenHandler: (() => unknown) | null = null
    setWindowOpenHandler(h: () => unknown): void {
      this.windowOpenHandler = h
    }
    debugger = {
      isAttached: () => false,
      attach(): void {},
      detach(): void {},
      sendCommand: async () => ({}),
      on(): void {}
    }
    getURL(): string {
      return 'http://localhost:3000/'
    }
    isLoading(): boolean {
      return false
    }
    snapshotGestures: boolean[] = []
    async executeJavaScript(script: string, gesture?: boolean): Promise<unknown> {
      if (script.includes('data-houston-ref')) {
        this.snapshotGestures.push(gesture === true)
        return '- button "Go" [ref=e1]'
      }
      return ''
    }
  }
  class FakeWindow {
    webContents = new FakeWebContents()
    destroyed = false
    constructor(public options: { webPreferences: Record<string, unknown> }) {
      state.windows.push(this)
    }
    async loadURL(): Promise<void> {
      this.webContents.handlers.get('did-finish-load')?.()
    }
    getTitle(): string {
      return ''
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  const session = {
    fromPartition: (name: string, opts: unknown) => {
      state.partitions.push({ name, opts })
      const s = new FakeSession()
      state.sessions.push(s)
      return s
    }
  }
  return { state, session, BrowserWindow: FakeWindow }
})
vi.mock('electron', () => ({ BrowserWindow: fake.BrowserWindow, session: fake.session }))

const { wireLocalhostCapture, SESSION_NETWORK_LIMIT } = await import('./localhostCapture')
const { browserBackendOrNull, resetBrowserBackend, BLOCKED_BY_GUARD } = await import('./agent/browserSession')
const { resetCaptureBackend } = await import('./agent/viewlocalhost')

describe('the browser_session Electron backend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.state.partitions = []
    fake.state.sessions = []
    fake.state.windows = []
    wireLocalhostCapture()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetBrowserBackend()
    resetCaptureBackend()
  })

  const open = async () => {
    const backend = browserBackendOrNull()!
    const p = backend.open({ width: 1280, height: 800 })
    await vi.runAllTimersAsync()
    return p
  }

  it('gives every session its own in-memory, uncached partition', async () => {
    await open()
    await open()
    const names = fake.state.partitions.map((p) => p.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const p of fake.state.partitions) {
      expect(p.name).toMatch(/^browser-session-/)
      expect(p.name).not.toMatch(/^persist:/)
      expect(p.opts).toEqual({ cache: false })
    }
  })

  it('installs the same subresource guard, download block, and permission denial as the capture session', async () => {
    await open()
    const ses = fake.state.sessions[0]
    const before = ses.listeners.get('before')!
    const verdict = (url: string): boolean => {
      let cancel = false
      before({ url }, (r) => (cancel = r.cancel))
      return cancel
    }
    expect(verdict('http://169.254.169.254/latest/meta-data')).toBe(true)
    expect(verdict('http://10.0.0.5/')).toBe(true)
    expect(verdict('http://192.168.1.1/')).toBe(true)
    expect(verdict('http://localhost:3000/app.js')).toBe(false)
    expect(ses.downloadHandler).toBeTypeOf('function')
    let granted = true
    ;(ses.permissionHandler as (wc: unknown, p: string, cb: (g: boolean) => void) => void)(null, 'media', (g) => {
      granted = g
    })
    expect(granted).toBe(false)
  })

  it('builds the window exactly as hardened as a view_localhost capture, pinned to loopback', async () => {
    await open()
    const win = fake.state.windows[0]
    expect(win.options.webPreferences).toMatchObject({
      session: fake.state.sessions[0],
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      disableDialogs: true
    })
    expect(win.webContents.windowOpenHandler!()).toEqual({ action: 'deny' })
    const nav = win.webContents.handlers.get('will-navigate')!
    for (const [url, blocked] of [
      ['http://example.com/', true],
      ['http://169.254.169.254/', true],
      ['http://127.0.0.1:4000/', false]
    ] as const) {
      const e = { prevented: false, preventDefault(): void {
        this.prevented = true
      } }
      nav(e, url)
      expect(e.prevented).toBe(blocked)
    }
  })

  it('logs requests with status and timing, and those the guard blocked', async () => {
    const page = await open()
    const ses = fake.state.sessions[0]
    ses.listeners.get('send')!({ id: 1, url: 'http://localhost:3000/api', method: 'GET', timestamp: 1000 })
    ses.listeners.get('completed')!({
      id: 1,
      url: 'http://localhost:3000/api',
      method: 'GET',
      timestamp: 1042,
      statusCode: 201,
      resourceType: 'xhr'
    })
    ses.listeners.get('error')!({ id: 2, url: 'http://10.0.0.1/', method: 'GET', timestamp: 1050, error: BLOCKED_BY_GUARD })
    expect(page.networkEntries()).toEqual([
      { method: 'GET', url: 'http://localhost:3000/api', status: 201, durationMs: 42, resourceType: 'xhr' },
      { method: 'GET', url: 'http://10.0.0.1/', error: BLOCKED_BY_GUARD }
    ])
  })

  it('keeps a bounded network log', async () => {
    const page = await open()
    const done = fake.state.sessions[0].listeners.get('completed')!
    for (let i = 0; i < SESSION_NETWORK_LIMIT + 10; i++) {
      done({ id: i, url: `http://localhost/${i}`, method: 'GET', timestamp: i, statusCode: 200 })
    }
    expect(page.networkEntries()).toHaveLength(SESSION_NETWORK_LIMIT)
    expect(page.networkEntries().at(-1)!.url).toBe(`http://localhost/${SESSION_NETWORK_LIMIT + 9}`)
  })

  it('reads the snapshot without a user gesture', async () => {
    const page = await open()
    expect(await page.snapshot()).toBe('- button "Go" [ref=e1]')
    expect(fake.state.windows[0].webContents.snapshotGestures).toEqual([false])
  })

  it('destroys the window and clears what the page stored on close', async () => {
    const page = await open()
    expect(page.isClosed()).toBe(false)
    page.close()
    expect(fake.state.windows[0].destroyed).toBe(true)
    expect(page.isClosed()).toBe(true)
    expect(fake.state.sessions[0].cleared).toBe(1)
  })

  it('reports a crashed renderer as closed', async () => {
    const page = await open()
    fake.state.windows[0].webContents.handlers.get('render-process-gone')!()
    expect(page.isClosed()).toBe(true)
  })
})
