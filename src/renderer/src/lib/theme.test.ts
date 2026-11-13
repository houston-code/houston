import { describe, it, expect } from 'vitest'
import { applyAccent, resolveTheme } from './theme'

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

describe('applyAccent', () => {
  it('sets data-accent for a preset and removes it for the default or an unknown value', () => {
    const root = document.createElement('div')
    applyAccent('green', root)
    expect(root.getAttribute('data-accent')).toBe('green')
    applyAccent('default', root)
    expect(root.hasAttribute('data-accent')).toBe(false)
    applyAccent('pink', root)
    applyAccent(undefined, root)
    expect(root.hasAttribute('data-accent')).toBe(false)
    applyAccent('chartreuse' as never, root)
    expect(root.hasAttribute('data-accent')).toBe(false)
  })
})
