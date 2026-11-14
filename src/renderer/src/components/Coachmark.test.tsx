import { describe, expect, it } from 'vitest'
import { TIP_IDS } from '@shared/onboarding'
import { tipCopy } from './Coachmark'


describe('tipCopy', () => {
  it('spells shortcuts with Mac glyphs on macOS', () => {
    expect(tipCopy('approval', true).body).toContain('⇧Tab cycles modes.')
    expect(tipCopy('steer', true).body).toContain('Queue (⌘↵)')
    expect(tipCopy('revert', true).body).toContain('Everything else: ⌘K.')
  })

  it('spells them with key names elsewhere', () => {
    expect(tipCopy('approval', false).body).toContain('Shift+Tab cycles modes.')
    expect(tipCopy('steer', false).body).toContain('Queue (Ctrl+↵)')
    expect(tipCopy('revert', false).body).toContain('Everything else: Ctrl+K.')
  })

  it('names the worktree folder once', () => {
    expect(tipCopy('worktree', true).body).toBe(
      'With New worktree on, this chat runs on its own branch in a separate worktree folder.'
    )
  })

  it('says Enter steers, matching the message box', () => {
    expect(tipCopy('steer', true).body).toMatch(/^Steer \(↵\) sends this now/)
  })

  it('has a title and body for every tip, with no em dashes', () => {
    for (const id of TIP_IDS) {
      for (const mac of [true, false]) {
        const c = tipCopy(id, mac)
        expect(c.title.length).toBeGreaterThan(0)
        expect(c.body.length).toBeGreaterThan(0)
        expect(c.title + c.body).not.toContain('\u2014')
      }
    }
  })
})
