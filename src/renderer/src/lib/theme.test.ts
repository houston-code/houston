import { describe, it, expect } from 'vitest'
import { applyAccent, applyAppearance, resolveTheme } from './theme'

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

describe('applyAppearance', () => {
  it('sets an attribute only for a value other than the default', () => {
    const root = document.createElement('div')
    applyAppearance({ chatFontSize: 'large', density: 'compact', codeTheme: 'muted' }, root)
    expect(root.getAttribute('data-chat-size')).toBe('large')
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('data-code-theme')).toBe('muted')
    applyAppearance({ chatFontSize: 'default', density: 'comfortable', codeTheme: 'default' }, root)
    expect(root.hasAttribute('data-chat-size')).toBe(false)
    expect(root.hasAttribute('data-density')).toBe(false)
    expect(root.hasAttribute('data-code-theme')).toBe(false)
  })

  it('treats unset and unknown values as the default', () => {
    const root = document.createElement('div')
    applyAppearance({ chatFontSize: 'small' }, root)
    applyAppearance({}, root)
    expect(root.hasAttribute('data-chat-size')).toBe(false)
    applyAppearance({ codeTheme: 'neon' as never }, root)
    expect(root.hasAttribute('data-code-theme')).toBe(false)
  })
})
