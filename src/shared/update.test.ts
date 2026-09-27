import { describe, expect, it } from 'vitest'
import { highlightsFor, RELEASE_HIGHLIGHTS, updateErrorHint } from './update'

describe('highlightsFor', () => {
  it('returns the bundled highlights for a known version', () => {
    expect(highlightsFor('0.1.0')).toBe(RELEASE_HIGHLIGHTS['0.1.0'])
  })

  it('returns null for a version with no recorded highlights', () => {
    expect(highlightsFor('9.9.9')).toBeNull()
  })

  it('keeps every entry short enough for the small popup (≤ 2 lines)', () => {
    for (const [version, text] of Object.entries(RELEASE_HIGHLIGHTS)) {
      expect(text.length, version).toBeLessThanOrEqual(160)
      expect(text.split('\n').length, version).toBeLessThanOrEqual(2)
    }
  })
})

describe('updateErrorHint', () => {
  it('gives a connection hint for network failures', () => {
    for (const m of [
      'net::ERR_NAME_NOT_RESOLVED',
      'net::ERR_INTERNET_DISCONNECTED',
      'getaddrinfo ENOTFOUND api.github.com',
      'connect ECONNREFUSED 127.0.0.1:443',
      'read ECONNRESET',
      'connect ETIMEDOUT 140.82.112.3:443'
    ]) {
      expect(updateErrorHint(m), m).toBe('Check your internet connection and try again.')
    }
  })

  it('gives no hint for other failures, where a connection hint would mislead', () => {
    expect(updateErrorHint('APPIMAGE env is not defined, current application is not an AppImage')).toBeNull()
    expect(updateErrorHint('Cannot find latest-mac.yml in the latest release artifacts')).toBeNull()
    expect(updateErrorHint(undefined)).toBeNull()
  })
})
