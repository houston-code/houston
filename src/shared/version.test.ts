import { describe, it, expect } from 'vitest'
import { parseVersion, isNewerVersion } from './version'

describe('parseVersion', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('v0.2.141')).toEqual({ major: 0, minor: 2, patch: 141 })
  })

  it('parses a prerelease tag', () => {
    expect(parseVersion('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 'beta.1' })
  })

  it('returns null for anything that is not a version', () => {
    expect(parseVersion('dev')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('nightly-2026-07-16')).toBeNull()
  })
})

describe('isNewerVersion', () => {
  it('orders by major, then minor, then patch', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('1.3.0', '1.2.9')).toBe(true)
    expect(isNewerVersion('0.2.142', '0.2.141')).toBe(true)
    expect(isNewerVersion('1.9.9', '2.0.0')).toBe(false)
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
  })

  it('does not treat a large patch as a smaller one (numeric, not lexical)', () => {
    // '0.2.9' > '0.2.141' as strings, which is exactly the bug a string compare gives.
    expect(isNewerVersion('0.2.9', '0.2.141')).toBe(false)
    expect(isNewerVersion('0.2.141', '0.2.9')).toBe(true)
  })

  it('sorts a prerelease below the release of the same version', () => {
    expect(isNewerVersion('1.2.3-beta.1', '1.2.3')).toBe(false)
    expect(isNewerVersion('1.2.3', '1.2.3-beta.1')).toBe(true)
  })

  // The failure that matters is nagging about a version that is not newer, so
  // anything unparseable stays quiet rather than guessing.
  it('never reports newer when either side is unparseable', () => {
    expect(isNewerVersion('1.2.3', 'dev')).toBe(false)
    expect(isNewerVersion('garbage', '1.2.3')).toBe(false)
    expect(isNewerVersion('dev', 'dev')).toBe(false)
  })
})
