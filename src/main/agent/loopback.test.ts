import { describe, expect, it } from 'vitest'
import { detectLocalUrl, isLoopbackHost, validateLocalhostUrl } from './loopback'

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
