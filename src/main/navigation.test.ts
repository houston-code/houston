import { describe, it, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import { isAllowedNavigation } from './navigation'

describe('isAllowedNavigation', () => {
  const startUrl = pathToFileURL('/Applications/Houston.app/Contents/renderer/index.html').toString()

  it('allows the exact start document', () => {
    expect(isAllowedNavigation(startUrl, startUrl)).toBe(true)
  })

  it('allows in-app hash/query routing on the same document', () => {
    expect(isAllowedNavigation(`${startUrl}#/settings`, startUrl)).toBe(true)
    expect(isAllowedNavigation(`${startUrl}?x=1`, startUrl)).toBe(true)
  })

  it('blocks a dropped file:// navigation to another path (the attack)', () => {
    const dropped = pathToFileURL('/Users/victim/Downloads/evil.html').toString()
    expect(isAllowedNavigation(dropped, startUrl)).toBe(false)
  })

  it('blocks remote origins and custom schemes', () => {
    for (const u of [
      'https://evil.example/',
      'http://evil.example/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'about:blank',
      ''
    ]) {
      expect(isAllowedNavigation(u, startUrl)).toBe(false)
    }
  })

  it('does NOT treat a sibling path with the same prefix as the start doc', () => {
    // `index.html.evil.html` must not slip through a naive startsWith check.
    const sibling = `${startUrl}.evil.html`
    expect(isAllowedNavigation(sibling, startUrl)).toBe(false)
  })

  it('allows same-origin dev-server navigations only when a dev URL is set', () => {
    const devUrl = 'http://localhost:5173'
    expect(isAllowedNavigation('http://localhost:5173/src/main.tsx', devUrl, devUrl)).toBe(true)
    // A different origin is still blocked even in dev.
    expect(isAllowedNavigation('http://localhost:9999/', devUrl, devUrl)).toBe(false)
    expect(isAllowedNavigation('https://evil.example/', devUrl, devUrl)).toBe(false)
    // Without a dev URL (production), an http origin is never allowed.
    expect(isAllowedNavigation('http://localhost:5173/', startUrl)).toBe(false)
  })
})
