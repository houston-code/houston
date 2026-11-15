import { describe, expect, it } from 'vitest'
import type { PermissionRule } from '@shared/types'
import { makePainter } from './tui'
import { renderSavedRules } from './tui-saved-rules'

const paint = makePainter(false)
const rule = (over: Partial<PermissionRule>): PermissionRule => ({
  action: 'allow',
  tool: 'run_shell',
  match: 'npm test',
  source: 'prompt',
  addedAt: 100,
  ...over
})

describe('renderSavedRules', () => {
  it('names the saved rule with its /permissions number and how to remove it', () => {
    const older = rule({ match: 'ls', addedAt: 1, source: 'settings' })
    const saved = rule({})
    const out = renderSavedRules([saved], [older, saved], 'allow', paint)
    expect(out).toContain('Saved a permission rule:')
    expect(out).toContain('2. Allow run_shell: npm test')
    expect(out).toContain('To take it back: /permissions remove 2.')
    expect(out).not.toContain('—')
  })

  it('lists several from the highest number, since removing one renumbers the rest', () => {
    const a = rule({ match: 'git status', addedAt: 100 })
    const b = rule({ match: 'npm test', addedAt: 101 })
    const out = renderSavedRules([a, b], [a, b], 'allow', paint)
    expect(out).toContain('Saved 2 permission rules:')
    expect(out).toContain('/permissions remove 2, then /permissions remove 1.')
  })

  it('says when an existing rule already covered it', () => {
    expect(renderSavedRules([], [], 'deny', paint)).toContain('A saved rule already covers this')
  })

  it('keeps control characters from the agent out of the terminal', () => {
    const r = rule({ match: 'echo \u001b[2J' })
    expect(renderSavedRules([r], [r], 'allow', paint)).not.toContain('\u001b[2J')
  })
})
