import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_EXPECT_MS,
  MAX_PAGE_TEXT_CHARS,
  MAX_STEPS,
  MAX_WAIT_FOR_MS,
  MAX_WAIT_MS,
  REDACTED_PASSWORD,
  PRESS_KEYS,
  STEP_ACTIONS,
  captureLocalhost,
  describeStep,
  formatConsole,
  formatPageText,
  parseSteps,
  scrubTypedPasswords,
  runSteps,
  type CaptureStep,
  isBlockedSubresourceHost,
  isLoopbackHost,
  loadWithDeadline,
  resetCaptureBackend,
  setCaptureBackend,
  validateLocalhostUrl,
  type CaptureSession,
  type ConsoleEntry,
  type Rect
} from './viewlocalhost'

describe('isLoopbackHost', () => {
  it('accepts loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('app.localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.5.6.7')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(true)
  })

  it('rejects LAN, private, and public hosts (narrower than web_fetch)', () => {
    expect(isLoopbackHost('10.0.0.5')).toBe(false)
    expect(isLoopbackHost('192.168.1.1')).toBe(false)
    expect(isLoopbackHost('172.16.4.4')).toBe(false)
    expect(isLoopbackHost('169.254.169.254')).toBe(false) // cloud metadata
    expect(isLoopbackHost('example.com')).toBe(false)
    expect(isLoopbackHost('8.8.8.8')).toBe(false)
    expect(isLoopbackHost('999.0.0.1')).toBe(false)
  })

  it('recognizes IPv4-mapped IPv6 loopback but not mapped metadata/LAN', () => {
    expect(isLoopbackHost('[::ffff:127.0.0.1]')).toBe(true)
    expect(isLoopbackHost('::ffff:7f00:1')).toBe(true) // hex form
    expect(isLoopbackHost('::ffff:169.254.169.254')).toBe(false) // metadata, not loopback
    expect(isLoopbackHost('::ffff:192.168.1.1')).toBe(false) // LAN, not loopback
  })
})

describe('isBlockedSubresourceHost', () => {
  it('blocks private, LAN, link-local, and metadata hosts', () => {
    expect(isBlockedSubresourceHost('169.254.169.254')).toBe(true) // cloud metadata
    expect(isBlockedSubresourceHost('10.0.0.5')).toBe(true)
    expect(isBlockedSubresourceHost('192.168.1.1')).toBe(true)
    expect(isBlockedSubresourceHost('172.16.4.4')).toBe(true)
    expect(isBlockedSubresourceHost('100.64.0.1')).toBe(true) // CGNAT
    expect(isBlockedSubresourceHost('fe80::1')).toBe(true) // link-local v6
    // IPv4-mapped IPv6 egress to metadata/LAN — the bypass this fixes. The capture
    // session's onBeforeRequest receives the hex-compressed form from new URL().
    expect(isBlockedSubresourceHost('[::ffff:169.254.169.254]')).toBe(true)
    expect(isBlockedSubresourceHost('::ffff:a9fe:a9fe')).toBe(true) // hex metadata
    expect(isBlockedSubresourceHost('::ffff:192.168.1.1')).toBe(true)
    expect(isBlockedSubresourceHost('::ffff:c0a8:101')).toBe(true) // hex LAN
  })

  it('allows loopback (the dev server) and public hosts (CDNs)', () => {
    expect(isBlockedSubresourceHost('localhost')).toBe(false)
    expect(isBlockedSubresourceHost('127.0.0.1')).toBe(false)
    expect(isBlockedSubresourceHost('::1')).toBe(false)
    expect(isBlockedSubresourceHost('0.0.0.0')).toBe(false)
    expect(isBlockedSubresourceHost('example.com')).toBe(false)
    expect(isBlockedSubresourceHost('cdn.jsdelivr.net')).toBe(false)
    expect(isBlockedSubresourceHost('8.8.8.8')).toBe(false)
    expect(isBlockedSubresourceHost('[::ffff:127.0.0.1]')).toBe(false) // mapped loopback OK
  })

  it('allows hostless URLs (data:/blob:/about:)', () => {
    expect(isBlockedSubresourceHost('')).toBe(false)
  })
})

describe('validateLocalhostUrl', () => {
  it('accepts loopback http(s) URLs', () => {
    expect(validateLocalhostUrl('http://localhost:3000/app').hostname).toBe('localhost')
    expect(validateLocalhostUrl('https://127.0.0.1:8443').hostname).toBe('127.0.0.1')
  })

  it('rejects non-loopback hosts', () => {
    expect(() => validateLocalhostUrl('http://example.com')).toThrow(/loopback/)
    expect(() => validateLocalhostUrl('http://192.168.0.10:3000')).toThrow(/loopback/)
  })

  it('rejects non-http schemes and malformed URLs', () => {
    expect(() => validateLocalhostUrl('file:///etc/passwd')).toThrow(/http and https/)
    expect(() => validateLocalhostUrl('not a url')).toThrow(/Invalid URL/)
  })
})

describe('formatConsole', () => {
  it('formats and drops blank entries', () => {
    const entries: ConsoleEntry[] = [
      { level: 'error', text: 'boom' },
      { level: 'info', text: '   ' },
      { level: 'warning', text: 'careful' }
    ]
    expect(formatConsole(entries)).toEqual(['ERROR: boom', 'WARNING: careful'])
  })

  it('caps very chatty pages and notes the omission', () => {
    const entries: ConsoleEntry[] = Array.from({ length: 250 }, (_, i) => ({
      level: 'log',
      text: `line ${i}`
    }))
    const out = formatConsole(entries)
    expect(out).toHaveLength(201) // 200 kept + the omission marker
    expect(out[0]).toMatch(/earlier console line/)
    expect(out[out.length - 1]).toBe('LOG: line 249')
  })
})

/** A fake CaptureSession so the orchestration can be tested without Electron. */
function fakeSession(over: Partial<CaptureSession> = {}): {
  session: CaptureSession
  closed: () => boolean
} {
  let closed = false
  const session: CaptureSession = {
    load: over.load ?? (async () => ({})),
    title: over.title ?? (() => 'My App'),
    url: over.url ?? (() => 'http://localhost:3000/'),
    rectForSelector: over.rectForSelector ?? (async () => null),
    screenshot: over.screenshot ?? (async () => Buffer.from('PNGBYTES')),
    consoleEntries: over.consoleEntries ?? (() => []),
    runStep: over.runStep ?? (async () => ({ ok: true as const })),
    pageText: over.pageText ?? (async () => 'Hello'),
    typedSecrets: over.typedSecrets ?? (() => []),
    close: () => {
      closed = true
      over.close?.()
    }
  }
  return { session, closed: () => closed }
}

describe('captureLocalhost', () => {
  it('returns a screenshot, console, and metadata, then closes the session', async () => {
    const { session, closed } = fakeSession({
      screenshot: async () => Buffer.from('imgbytes'),
      consoleEntries: () => [{ level: 'error', text: 'kaboom' }]
    })
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000' },
      { open: async () => session }
    )
    expect(cap.png.toString()).toBe('imgbytes')
    expect(cap.console).toEqual(['ERROR: kaboom'])
    expect(cap.title).toBe('My App')
    expect(cap.finalUrl).toBe('http://localhost:3000/')
    expect(cap.width).toBe(1280)
    expect(cap.height).toBe(800)
    expect(closed()).toBe(true)
  })

  it('captures a selector bounding box when it matches', async () => {
    let rectArg: Rect | undefined
    const rect: Rect = { x: 10, y: 20, width: 100, height: 50 }
    const { session } = fakeSession({
      rectForSelector: async () => rect,
      screenshot: async (r) => {
        rectArg = r
        return Buffer.from('x')
      }
    })
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', selector: '#app' },
      { open: async () => session }
    )
    expect(rectArg).toEqual(rect)
    expect(cap.width).toBe(100)
    expect(cap.height).toBe(50)
    expect(cap.selectorMissed).toBeUndefined()
  })

  it('falls back to the full viewport when the selector matches nothing', async () => {
    const { session } = fakeSession({ rectForSelector: async () => null })
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', selector: '.nope' },
      { open: async () => session }
    )
    expect(cap.selectorMissed).toBe(true)
    expect(cap.width).toBe(1280)
  })

  it('surfaces a load error but still returns a screenshot', async () => {
    const { session } = fakeSession({ load: async () => ({ loadError: 'connection refused (-102)' }) })
    const cap = await captureLocalhost(
      { url: 'http://localhost:5173' },
      { open: async () => session }
    )
    expect(cap.loadError).toBe('connection refused (-102)')
    expect(cap.png).toBeInstanceOf(Buffer)
  })

  it('refuses a non-loopback URL before opening any window', async () => {
    const open = vi.fn()
    await expect(
      captureLocalhost({ url: 'http://example.com' }, { open })
    ).rejects.toThrow(/loopback/)
    expect(open).not.toHaveBeenCalled()
  })

  it('rejects and still closes when aborted mid-capture', async () => {
    const ac = new AbortController()
    const { session, closed } = fakeSession({ load: () => new Promise<never>(() => {}) })
    const p = captureLocalhost(
      { url: 'http://localhost:3000', signal: ac.signal },
      { open: async () => session }
    )
    ac.abort()
    await expect(p).rejects.toThrow(/cancelled/)
    expect(closed()).toBe(true)
  })
})

describe('loadWithDeadline', () => {
  it('resolves with a timeout warning when the page never finishes loading', async () => {
    const { session } = fakeSession({ load: () => new Promise<never>(() => {}) })
    const r = await loadWithDeadline(session, 'http://localhost:3000/', 10)
    expect(r.loadError).toMatch(/did not finish loading/)
  })

  it('rejects when aborted before the load settles', async () => {
    const ac = new AbortController()
    const { session } = fakeSession({ load: () => new Promise<never>(() => {}) })
    const p = loadWithDeadline(session, 'http://localhost:3000/', 1000, ac.signal)
    ac.abort()
    await expect(p).rejects.toThrow(/cancelled/)
  })
})

describe('capture backend injection', () => {
  afterEach(() => resetCaptureBackend())

  it('throws a clear error when no backend is wired and no deps are passed', async () => {
    resetCaptureBackend()
    await expect(captureLocalhost({ url: 'http://localhost:3000' })).rejects.toThrow(/not configured/)
  })

  it('uses the wired backend when deps are omitted', async () => {
    const { session, closed } = fakeSession({ screenshot: async () => Buffer.from('wired') })
    const open = vi.fn(async () => session)
    setCaptureBackend({ open })

    const cap = await captureLocalhost({ url: 'http://localhost:3000' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(cap.png.toString()).toBe('wired')
    expect(closed()).toBe(true)
  })

  it('lets explicit deps override the wired backend', async () => {
    const wired = vi.fn()
    setCaptureBackend({ open: wired })
    const { session } = fakeSession({ screenshot: async () => Buffer.from('explicit') })

    const cap = await captureLocalhost({ url: 'http://localhost:3000' }, { open: async () => session })
    expect(wired).not.toHaveBeenCalled()
    expect(cap.png.toString()).toBe('explicit')
  })
})

describe('parseSteps', () => {
  it('accepts fill, click, wait_for, and wait, and fills in defaults', () => {
    expect(
      parseSteps([
        { action: 'fill', selector: '#email', value: 'a@b.c' },
        { action: 'click', selector: 'button[type=submit]' },
        { action: 'wait_for', selector: '.dashboard' },
        { action: 'wait' }
      ])
    ).toEqual([
      { action: 'fill', selector: '#email', value: 'a@b.c' },
      { action: 'click', selector: 'button[type=submit]' },
      { action: 'wait_for', selector: '.dashboard', timeoutMs: MAX_WAIT_FOR_MS },
      { action: 'wait', ms: 500 }
    ])
  })

  it('accepts dblclick, and press with or without a selector', () => {
    expect(
      parseSteps([
        { action: 'dblclick', selector: '.todo label' },
        { action: 'press', key: 'Enter' },
        { action: 'press', key: 'Escape', selector: '.edit' }
      ])
    ).toEqual([
      { action: 'dblclick', selector: '.todo label' },
      { action: 'press', key: 'Enter' },
      { action: 'press', key: 'Escape', selector: '.edit' }
    ])
  })

  it('canonicalizes a press key regardless of casing', () => {
    expect(parseSteps([{ action: 'press', key: 'enter' }])).toEqual([{ action: 'press', key: 'Enter' }])
    expect(parseSteps([{ action: 'press', key: 'ARROWDOWN' }])).toEqual([{ action: 'press', key: 'ArrowDown' }])
  })

  it('treats an empty press selector as no selector', () => {
    for (const selector of [null, '', '   ']) {
      expect(parseSteps([{ action: 'press', key: 'Tab', selector }])).toEqual([{ action: 'press', key: 'Tab' }])
    }
  })

  it('rejects a press without a supported key, and a dblclick without a selector', () => {
    expect(() => parseSteps([{ action: 'press' }])).toThrow(/steps\[0\]\.key must be one of Enter, Escape/)
    expect(() => parseSteps([{ action: 'press', key: 'a' }])).toThrow(/key must be one of/)
    expect(() => parseSteps([{ action: 'press', key: 'Control+A' }])).toThrow(/key must be one of/)
    expect(() => parseSteps([{ action: 'press', key: 13 }])).toThrow(/key must be one of/)
    expect(() => parseSteps([{ action: 'press', key: 'Enter', selector: 'a'.repeat(501) }])).toThrow(/longer than/)
    expect(() => parseSteps([{ action: 'dblclick' }])).toThrow(/steps\[0\]\.selector is required for "dblclick"/)
  })

  it('names every action and key in its errors', () => {
    expect(() => parseSteps([{ action: 'hover', selector: 'a' }])).toThrow(
      `steps[0].action must be one of ${STEP_ACTIONS.join(', ')}.`
    )
    expect(STEP_ACTIONS).toEqual(['fill', 'click', 'dblclick', 'press', 'wait_for', 'expect_text', 'wait'])
    expect(() => parseSteps([{ action: 'press', key: 'F5' }])).toThrow(PRESS_KEYS.join(', '))
  })

  it('accepts expect_text, scoped or page-wide, present or absent', () => {
    expect(
      parseSteps([
        { action: 'expect_text', value: 'Buy milk' },
        { action: 'expect_text', value: 'Buy milk', selector: '.todo-list li', timeout_ms: 1500 },
        { action: 'expect_text', value: 'Error', absent: true, selector: '' }
      ])
    ).toEqual([
      { action: 'expect_text', text: 'Buy milk', absent: false, timeoutMs: DEFAULT_EXPECT_MS },
      { action: 'expect_text', text: 'Buy milk', selector: '.todo-list li', absent: false, timeoutMs: 1500 },
      { action: 'expect_text', text: 'Error', absent: true, timeoutMs: DEFAULT_EXPECT_MS }
    ])
  })

  it('clamps an expect_text timeout and only takes absent when it is true', () => {
    expect(parseSteps([{ action: 'expect_text', value: 'x', timeout_ms: 60_000, absent: 'yes' }])).toEqual([
      { action: 'expect_text', text: 'x', absent: false, timeoutMs: MAX_WAIT_FOR_MS }
    ])
  })

  it('rejects an expect_text without text to look for', () => {
    expect(() => parseSteps([{ action: 'expect_text' }])).toThrow(/steps\[0\]\.value is required for "expect_text"/)
    expect(() => parseSteps([{ action: 'expect_text', value: '   ' }])).toThrow(/value is required/)
    expect(() => parseSteps([{ action: 'expect_text', value: 'v'.repeat(501) }])).toThrow(/longer than 500/)
    expect(() => parseSteps([{ action: 'expect_text', value: 'v', selector: 's'.repeat(501) }])).toThrow(
      /selector is longer than/
    )
  })

  it('treats a missing steps argument as no steps', () => {
    expect(parseSteps(undefined)).toEqual([])
    expect(parseSteps(null)).toEqual([])
  })

  it('clamps waits to their caps instead of refusing', () => {
    expect(parseSteps([{ action: 'wait', ms: 60_000 }])).toEqual([{ action: 'wait', ms: MAX_WAIT_MS }])
    expect(parseSteps([{ action: 'wait', ms: -5 }])).toEqual([{ action: 'wait', ms: 0 }])
    expect(parseSteps([{ action: 'wait_for', selector: 'x', timeout_ms: 99_999 }])).toEqual([
      { action: 'wait_for', selector: 'x', timeoutMs: MAX_WAIT_FOR_MS }
    ])
  })

  it('rejects malformed steps with a message naming the step', () => {
    expect(() => parseSteps('click')).toThrow(/must be an array/)
    expect(() => parseSteps([{ action: 'hover', selector: 'a' }])).toThrow(/steps\[0\]\.action/)
    expect(() => parseSteps([{ action: 'click' }])).toThrow(/steps\[0\]\.selector is required/)
    expect(() => parseSteps([{ action: 'click', selector: '  ' }])).toThrow(/selector is required/)
    expect(() => parseSteps([{ action: 'fill', selector: '#a' }])).toThrow(/value is required/)
    expect(() => parseSteps([null])).toThrow(/must be an object/)
    expect(() => parseSteps([{ action: 'click', selector: 'a'.repeat(501) }])).toThrow(/longer than/)
    expect(() => parseSteps([{ action: 'fill', selector: '#a', value: 'v'.repeat(10_001) }])).toThrow(/longer than/)
  })

  it('caps the number of steps', () => {
    const many = Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'wait' }))
    expect(() => parseSteps(many)).toThrow(/at most 20/)
    expect(parseSteps(many.slice(0, MAX_STEPS))).toHaveLength(MAX_STEPS)
  })
})

describe('describeStep', () => {
  it('never includes a filled value', () => {
    const d = describeStep({ action: 'fill', selector: '#password', value: 'hunter2' })
    expect(d).toBe('fill "#password"')
    expect(d).not.toContain('hunter2')
  })

  it('describes double clicks and key presses', () => {
    expect(describeStep({ action: 'dblclick', selector: '.todo label' })).toBe('double-click ".todo label"')
    expect(describeStep({ action: 'press', key: 'Enter' })).toBe('press Enter')
    expect(describeStep({ action: 'press', key: 'Escape', selector: '.edit' })).toBe('press Escape on ".edit"')
  })

  it('describes text expectations, including what is expected', () => {
    const step = { action: 'expect_text' as const, text: 'Buy milk', absent: false, timeoutMs: 3000 }
    expect(describeStep(step)).toBe('expect text "Buy milk"')
    expect(describeStep({ ...step, selector: 'li' })).toBe('expect text "Buy milk" in "li"')
    expect(describeStep({ ...step, absent: true })).toBe('expect no text "Buy milk"')
    expect(describeStep({ ...step, absent: true, selector: '.err' })).toBe('expect no text "Buy milk" in ".err"')
  })
})

describe('formatPageText', () => {
  it('trims lines, collapses runs of spaces, and drops blank lines', () => {
    expect(formatPageText('  todos \n\n\t What  needs\u00a0to be done? \n\n\nBuy milk\n', [])).toEqual({
      text: 'todos\nWhat needs to be done?\nBuy milk',
      truncated: false
    })
  })

  it('cuts long text to the cap and says so', () => {
    const { text, truncated } = formatPageText('x'.repeat(MAX_PAGE_TEXT_CHARS + 50), [])
    expect(text).toHaveLength(MAX_PAGE_TEXT_CHARS)
    expect(truncated).toBe(true)
    expect(formatPageText('x'.repeat(MAX_PAGE_TEXT_CHARS), []).truncated).toBe(false)
  })

  it('scrubs every value typed into a password field, before cutting', () => {
    const raw = `Signed in. Preview: hunter2!x\n${'y'.repeat(MAX_PAGE_TEXT_CHARS)}`
    const { text } = formatPageText(raw, ['hunter2!x'])
    expect(text).not.toContain('hunter2')
    expect(text.startsWith(`Signed in. Preview: ${REDACTED_PASSWORD}`)).toBe(true)
  })
})

describe('scrubTypedPasswords', () => {
  it('replaces every literal occurrence, treating regex characters literally', () => {
    expect(scrubTypedPasswords('a.b+c a.b+c abxc', ['a.b+c'])).toBe(
      `${REDACTED_PASSWORD} ${REDACTED_PASSWORD} abxc`
    )
  })

  it('ignores empty secrets', () => {
    expect(scrubTypedPasswords('abc', ['', 'zz'])).toBe('abc')
  })
})

describe('runSteps', () => {
  const steps: CaptureStep[] = [
    { action: 'fill', selector: '#u', value: 'x' },
    { action: 'click', selector: 'button' },
    { action: 'wait_for', selector: '.ok', timeoutMs: 100 }
  ]

  it('runs every step in order and reports each', async () => {
    const seen: string[] = []
    const { session } = fakeSession({
      runStep: async (s) => {
        seen.push(s.action)
        return { ok: true }
      }
    })
    const r = await runSteps(session, steps)
    expect(seen).toEqual(['fill', 'click', 'wait_for'])
    expect(r.every((x) => x.ok)).toBe(true)
  })

  it('stops at the first failure', async () => {
    const seen: string[] = []
    const { session } = fakeSession({
      runStep: async (s) => {
        seen.push(s.action)
        return s.action === 'click' ? { ok: false, error: 'no element matches the selector' } : { ok: true }
      }
    })
    const r = await runSteps(session, steps)
    expect(seen).toEqual(['fill', 'click'])
    expect(r).toEqual([
      { step: 'fill "#u"', ok: true },
      { step: 'click "button"', ok: false, error: 'no element matches the selector' }
    ])
  })

  it('turns a thrown step into a failure instead of failing the capture', async () => {
    const { session } = fakeSession({
      runStep: async () => {
        throw new Error('renderer gone')
      }
    })
    expect(await runSteps(session, steps.slice(0, 1))).toEqual([
      { step: 'fill "#u"', ok: false, error: 'renderer gone' }
    ])
  })

  it('stops once the overall budget is used up', async () => {
    let t = 0
    const { session } = fakeSession({
      runStep: async () => {
        t += 40
        return { ok: true }
      }
    })
    const r = await runSteps(session, steps, undefined, 50, () => t)
    expect(r.map((x) => x.ok)).toEqual([true, true, false])
    expect(r[2].error).toMatch(/budget/)
  })

  it('honors an abort between steps', async () => {
    const ac = new AbortController()
    const { session } = fakeSession({
      runStep: async () => {
        ac.abort()
        return { ok: true }
      }
    })
    await expect(runSteps(session, steps, ac.signal)).rejects.toThrow(/cancelled/)
  })
})

describe('captureLocalhost page text', () => {
  it('returns the formatted visible text', async () => {
    const { session } = fakeSession({ pageText: async () => '  Todos \n\n Buy milk ' })
    const cap = await captureLocalhost({ url: 'http://localhost:3000' }, { open: async () => session })
    expect(cap.pageText).toBe('Todos\nBuy milk')
    expect(cap.pageTextTruncated).toBeUndefined()
  })

  it('flags text cut to the cap', async () => {
    const { session } = fakeSession({ pageText: async () => 'z'.repeat(MAX_PAGE_TEXT_CHARS * 2) })
    const cap = await captureLocalhost({ url: 'http://localhost:3000' }, { open: async () => session })
    expect(cap.pageText).toHaveLength(MAX_PAGE_TEXT_CHARS)
    expect(cap.pageTextTruncated).toBe(true)
  })

  it('omits the text when the page could not be read', async () => {
    const { session } = fakeSession({ pageText: async () => null })
    const cap = await captureLocalhost({ url: 'http://localhost:3000' }, { open: async () => session })
    expect('pageText' in cap).toBe(false)
  })

  it('reads the text after the steps have run', async () => {
    const order: string[] = []
    const { session } = fakeSession({
      runStep: async (s) => {
        order.push(s.action)
        return { ok: true }
      },
      pageText: async () => {
        order.push('pageText')
        return ''
      }
    })
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', steps: [{ action: 'press', key: 'Enter' }] },
      { open: async () => session }
    )
    expect(order).toEqual(['press', 'pageText'])
    expect(cap.pageText).toBe('')
  })

  it('never reports a value typed into a password field, in the page text or the console', async () => {
    const { session } = fakeSession({
      typedSecrets: () => ['test-only-pass'],
      pageText: async () => 'Welcome back\nYour password is test-only-pass',
      consoleEntries: () => [{ level: 'log', text: 'submitting {"password":"test-only-pass"}' }]
    })
    const cap = await captureLocalhost({ url: 'http://localhost:3000' }, { open: async () => session })
    expect(cap.pageText).toBe(`Welcome back\nYour password is ${REDACTED_PASSWORD}`)
    expect(cap.console).toEqual([`LOG: submitting {"password":"${REDACTED_PASSWORD}"}`])
  })
})

describe('captureLocalhost with steps', () => {
  it('runs steps after load and before the screenshot, and returns their results', async () => {
    const order: string[] = []
    const { session, closed } = fakeSession({
      load: async () => {
        order.push('load')
        return {}
      },
      runStep: async (s) => {
        order.push(s.action)
        return { ok: true }
      },
      screenshot: async () => {
        order.push('screenshot')
        return Buffer.from('PNG')
      }
    })
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', steps: [{ action: 'click', selector: '#go' }] },
      { open: async () => session }
    )
    expect(order).toEqual(['load', 'click', 'screenshot'])
    expect(cap.steps).toEqual([{ step: 'click "#go"', ok: true }])
    expect(closed()).toBe(true)
  })

  it('still screenshots after a failed step', async () => {
    let shot = false
    const { session } = fakeSession({
      runStep: async () => ({ ok: false, error: 'no element matches the selector' }),
      screenshot: async () => {
        shot = true
        return Buffer.from('PNG')
      }
    })
    const cap = await captureLocalhost(
      { url: 'http://localhost:3000', steps: [{ action: 'click', selector: '#missing' }] },
      { open: async () => session }
    )
    expect(shot).toBe(true)
    expect(cap.steps?.[0].ok).toBe(false)
  })

  it('omits step results when no steps were given', async () => {
    const { session } = fakeSession()
    const cap = await captureLocalhost({ url: 'http://localhost:3000' }, { open: async () => session })
    expect(cap.steps).toBeUndefined()
  })
})
