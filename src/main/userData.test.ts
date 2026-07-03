import { afterEach, describe, expect, it } from 'vitest'
import { setUserDataDir, getUserDataDir, resetUserDataDir } from './userData'

describe('userData seam', () => {
  afterEach(() => resetUserDataDir())

  it('returns the bound directory', () => {
    setUserDataDir('/tmp/houston-profile')
    expect(getUserDataDir()).toBe('/tmp/houston-profile')
  })

  it('throws when read before being configured', () => {
    expect(() => getUserDataDir()).toThrow(/not configured/)
  })

  it('throws again after a reset', () => {
    setUserDataDir('/tmp/houston-profile')
    resetUserDataDir()
    expect(() => getUserDataDir()).toThrow(/not configured/)
  })
})
