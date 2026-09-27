import { describe, expect, it, vi } from 'vitest'

// The generated module holds only the running build's summary; pin it so these tests
// don't depend on whatever CHANGELOG.md currently says.
vi.mock('./release-highlights', () => ({
  RELEASE_SUMMARY: { version: '1.4.0', summary: 'Parallel test runs and a faster terminal client.' }
}))

import { highlightsFor, updateErrorHint } from './update'

describe('highlightsFor', () => {
  it("returns this build's changelog summary for its own version", () => {
    expect(highlightsFor('1.4.0')).toBe('Parallel test runs and a faster terminal client.')
  })

  it('returns null for any other version', () => {
    expect(highlightsFor('9.9.9')).toBeNull()
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
