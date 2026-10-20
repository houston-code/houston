import { describe, expect, it } from 'vitest'
import { detectLocalUrl, detectLocalUrls, isLoopbackHost, validateLocalhostUrl } from './loopback'

describe('detectLocalUrl', () => {
  it('finds the URL a Vite-style dev server prints', () => {
    expect(detectLocalUrl('  ➜  Local:   http://localhost:5173/')).toBe('http://localhost:5173/')
  })

  it('strips trailing punctuation a log line glues on', () => {
    expect(detectLocalUrl('Listening on http://127.0.0.1:3000.')).toBe('http://127.0.0.1:3000/')
    expect(detectLocalUrl('see (http://localhost:8080)')).toBe('http://localhost:8080/')
  })

  it('rewrites a wildcard bind to a reachable loopback address, keeping the port', () => {
    expect(detectLocalUrl('running at http://0.0.0.0:8000')).toBe('http://127.0.0.1:8000/')
  })

  it('returns the first loopback URL, skipping non-loopback ones', () => {
    const out = detectLocalUrl('proxying https://example.com -> http://localhost:4000/')
    expect(out).toBe('http://localhost:4000/')
  })

  it('ignores public/LAN hosts entirely', () => {
    expect(detectLocalUrl('Network: http://192.168.1.20:5173/')).toBeUndefined()
    expect(detectLocalUrl('deployed at https://app.example.com')).toBeUndefined()
    expect(detectLocalUrl('no url here at all')).toBeUndefined()
  })

  it('handles an IPv6 loopback and a port', () => {
    expect(detectLocalUrl('serving on http://[::1]:9000/')).toBe('http://[::1]:9000/')
  })
})

describe('detectLocalUrls', () => {
  it('returns every loopback URL a combined dev script prints, marking the one labeled Local:', () => {
    const out = [
      '[server] Once More server listening on http://localhost:3001',
      '[client]   VITE v5.4.21  ready in 176 ms',
      '[client]   ➜  Local:   http://localhost:5175/',
      '[client]   ➜  Network: use --host to expose'
    ].join('\n')
    expect(detectLocalUrls(out)).toEqual([
      { url: 'http://localhost:3001/', announced: false },
      { url: 'http://localhost:5175/', announced: true }
    ])
  })

  it('reads a URL that colored output split with escape codes', () => {
    // Vite with FORCE_COLOR: a bold port inside a cyan URL, after a bold "Local".
    const colored = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'
    expect(detectLocalUrls(colored)).toEqual([{ url: 'http://localhost:5173/', announced: true }])
    // An OSC 8 hyperlink around the URL.
    const linked = 'Local: \x1b]8;;http://localhost:4321/\x07http://localhost:4321/\x1b]8;;\x07'
    expect(detectLocalUrls(linked).map((f) => f.url)).toEqual(['http://localhost:4321/'])
  })

  it('lists a repeated URL once, labeled if any mention labeled it', () => {
    const out = 'started http://localhost:8000/\n  Local: http://localhost:8000/'
    expect(detectLocalUrls(out)).toEqual([{ url: 'http://localhost:8000/', announced: true }])
  })

  it('ignores LAN and public hosts', () => {
    expect(detectLocalUrls('Local: http://localhost:5173/\nNetwork: http://192.168.1.20:5173/')).toEqual([
      { url: 'http://localhost:5173/', announced: true }
    ])
  })
})

describe('loopback guards (re-exported surface)', () => {
  it('classifies loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })

  it('rejects a non-loopback URL', () => {
    expect(() => validateLocalhostUrl('http://example.com')).toThrow()
    expect(validateLocalhostUrl('http://localhost:3000').hostname).toBe('localhost')
  })
})
