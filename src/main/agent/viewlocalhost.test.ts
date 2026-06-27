import { describe, expect, it, vi } from 'vitest'
import {
  captureLocalhost,
  formatConsole,
  isBlockedSubresourceHost,
  isLoopbackHost,
  loadWithDeadline,
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
})

describe('isBlockedSubresourceHost', () => {
  it('blocks private, LAN, link-local, and metadata hosts', () => {
    expect(isBlockedSubresourceHost('169.254.169.254')).toBe(true) // cloud metadata
    expect(isBlockedSubresourceHost('10.0.0.5')).toBe(true)
    expect(isBlockedSubresourceHost('192.168.1.1')).toBe(true)
    expect(isBlockedSubresourceHost('172.16.4.4')).toBe(true)
    expect(isBlockedSubresourceHost('100.64.0.1')).toBe(true) // CGNAT
    expect(isBlockedSubresourceHost('fe80::1')).toBe(true) // link-local v6
  })

  it('allows loopback (the dev server) and public hosts (CDNs)', () => {
    expect(isBlockedSubresourceHost('localhost')).toBe(false)
    expect(isBlockedSubresourceHost('127.0.0.1')).toBe(false)
    expect(isBlockedSubresourceHost('::1')).toBe(false)
    expect(isBlockedSubresourceHost('0.0.0.0')).toBe(false)
    expect(isBlockedSubresourceHost('example.com')).toBe(false)
    expect(isBlockedSubresourceHost('cdn.jsdelivr.net')).toBe(false)
    expect(isBlockedSubresourceHost('8.8.8.8')).toBe(false)
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
