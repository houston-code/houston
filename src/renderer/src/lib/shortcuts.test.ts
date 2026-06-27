import { describe, it, expect } from 'vitest'
import { shortcutFor } from './shortcuts'

const ev = (key: string, mod = false): { key: string; metaKey: boolean; ctrlKey: boolean } => ({
  key,
  metaKey: mod,
  ctrlKey: false
})

describe('shortcutFor', () => {
  it('maps Cmd/Ctrl+N to new-chat', () => {
    expect(shortcutFor(ev('n', true))).toBe('new-chat')
    expect(shortcutFor({ key: 'N', metaKey: false, ctrlKey: true })).toBe('new-chat')
  })

  it('maps Cmd/Ctrl+B to toggle-sidebar', () => {
    expect(shortcutFor(ev('b', true))).toBe('toggle-sidebar')
    expect(shortcutFor({ key: 'B', metaKey: false, ctrlKey: true })).toBe('toggle-sidebar')
  })

  it('maps Cmd/Ctrl+comma to open-settings', () => {
    expect(shortcutFor(ev(',', true))).toBe('open-settings')
  })

  it('maps Ctrl+backtick to toggle-terminal', () => {
    expect(shortcutFor({ key: '`', metaKey: false, ctrlKey: true })).toBe('toggle-terminal')
  })

  it('does not map Cmd+backtick (Ctrl only) to toggle-terminal', () => {
    expect(shortcutFor({ key: '`', metaKey: true, ctrlKey: false })).toBeNull()
  })

  it('maps Escape to escape (no modifier needed)', () => {
    expect(shortcutFor(ev('Escape'))).toBe('escape')
  })

  it('ignores plain keys and unmodified letters', () => {
    expect(shortcutFor(ev('n'))).toBeNull()
    expect(shortcutFor(ev('a', true))).toBeNull()
  })
})
