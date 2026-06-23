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

  it('maps Cmd/Ctrl+comma to open-settings', () => {
    expect(shortcutFor(ev(',', true))).toBe('open-settings')
  })

  it('maps Escape to escape (no modifier needed)', () => {
    expect(shortcutFor(ev('Escape'))).toBe('escape')
  })

  it('ignores plain keys and unmodified letters', () => {
    expect(shortcutFor(ev('n'))).toBeNull()
    expect(shortcutFor(ev('a', true))).toBeNull()
  })
})
