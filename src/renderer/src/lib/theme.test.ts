import { describe, it, expect } from 'vitest'
import { resolveTheme } from './theme'

describe('resolveTheme', () => {
  it('honors explicit dark/light regardless of OS', () => {
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('light', false)).toBe('light')
  })

  it('follows the OS preference for "system"', () => {
    expect(resolveTheme('system', true)).toBe('light')
    expect(resolveTheme('system', false)).toBe('dark')
  })
})
