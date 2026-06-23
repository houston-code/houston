import { describe, expect, it } from 'vitest'
import { shouldAutoUpdate } from './update-policy'

describe('shouldAutoUpdate', () => {
  it('runs only for packaged builds', () => {
    expect(shouldAutoUpdate(false, {})).toBe(false)
    expect(shouldAutoUpdate(true, {})).toBe(true)
  })

  it('honors the HOUSTON_DISABLE_UPDATER opt-out even when packaged', () => {
    expect(shouldAutoUpdate(true, { HOUSTON_DISABLE_UPDATER: '1' })).toBe(false)
  })
})
