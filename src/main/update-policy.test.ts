import { describe, expect, it } from 'vitest'
import { shouldAutoUpdate, shouldShowWhatsNew } from './update-policy'

describe('shouldAutoUpdate', () => {
  it('runs only for packaged builds', () => {
    expect(shouldAutoUpdate(false, {})).toBe(false)
    expect(shouldAutoUpdate(true, {})).toBe(true)
  })

  it('honors the HOUSTON_DISABLE_UPDATER opt-out even when packaged', () => {
    expect(shouldAutoUpdate(true, { HOUSTON_DISABLE_UPDATER: '1' })).toBe(false)
  })
})

describe('shouldShowWhatsNew', () => {
  it('shows after an upgrade (recorded version differs from the running one)', () => {
    expect(shouldShowWhatsNew('0.1.0', '0.2.0')).toBe(true)
  })

  it('does not show on a fresh install (no recorded version)', () => {
    expect(shouldShowWhatsNew(null, '0.1.0')).toBe(false)
  })

  it('does not show when re-running the same version', () => {
    expect(shouldShowWhatsNew('0.2.0', '0.2.0')).toBe(false)
  })
})
