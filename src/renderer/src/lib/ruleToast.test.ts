import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, PermissionRule } from '@shared/types'
import {
  describeRule,
  ruleActionOf,
  savedRulesSince,
  savedRulesText,
  waitForSavedRules,
  withoutRules
} from './ruleToast'

const prompt = (over: Partial<PermissionRule>): PermissionRule => ({
  action: 'allow',
  tool: 'run_shell',
  match: 'npm test',
  source: 'prompt',
  addedAt: 100,
  ...over
})

describe('ruleToast', () => {
  it('maps only the Always decisions to a rule action', () => {
    expect(ruleActionOf('rule-allow')).toBe('allow')
    expect(ruleActionOf('rule-deny')).toBe('deny')
    expect(ruleActionOf('allow')).toBeNull()
    expect(ruleActionOf('always')).toBeNull()
    expect(ruleActionOf('deny')).toBeNull()
  })

  it('finds the prompt rules of the action stamped since the click', () => {
    const rules: PermissionRule[] = [
      prompt({ match: 'npm test', addedAt: 200 }),
      prompt({ match: 'old', addedAt: 50 }),
      prompt({ match: 'deny-me', action: 'deny', addedAt: 200 }),
      { action: 'allow', tool: 'run_shell', match: 'by hand', source: 'settings', addedAt: 300 },
      { action: 'allow', tool: 'run_shell', match: 'legacy' }
    ]
    expect(savedRulesSince(rules, 'allow', 100).map((r) => r.match)).toEqual(['npm test'])
    expect(savedRulesSince(rules, 'deny', 100).map((r) => r.match)).toEqual(['deny-me'])
    expect(savedRulesSince(undefined, 'allow', 0)).toEqual([])
  })

  it('describes a rule by verdict, tool and match', () => {
    expect(describeRule(prompt({}))).toBe('Allow run_shell: npm test')
    expect(describeRule(prompt({ action: 'deny', tool: 'web_search', match: '*' }))).toBe('Deny web_search: anything')
    expect(describeRule(prompt({ tool: '*', match: 'x' }))).toBe('Allow any tool: x')
  })

  it('says when no new rule was needed', () => {
    expect(savedRulesText([], 'allow')).toMatch(/already covers this/)
    expect(savedRulesText([prompt({})], 'allow')).toBe('Saved a permission rule:')
    expect(savedRulesText([prompt({}), prompt({ match: 'b' })], 'deny')).toBe('Saved 2 permission rules:')
  })

  it('removes exactly the saved rules, leaving a same-pattern rule added at another time', () => {
    const saved = prompt({ addedAt: 200 })
    const twin = prompt({ addedAt: 10 })
    const other = prompt({ match: 'ls' })
    expect(withoutRules([saved, twin, other], [saved])).toEqual([twin, other])
  })

  it('reads settings until the saved rule appears', async () => {
    const empty = { permissionRules: [] } as unknown as AppSettings
    const withRule = { permissionRules: [prompt({ addedAt: 150 })] } as unknown as AppSettings
    const read = vi.fn().mockResolvedValueOnce(empty).mockResolvedValueOnce(withRule)
    const sleep = vi.fn(async () => {})
    const got = await waitForSavedRules(read, 'allow', 100, sleep)
    expect(read).toHaveBeenCalledTimes(2)
    expect(got.saved.map((r) => r.match)).toEqual(['npm test'])
    expect(got.settings).toBe(withRule)
  })

  it('gives up with no rules when an existing rule already covered the call', async () => {
    const empty = { permissionRules: [] } as unknown as AppSettings
    const read = vi.fn().mockResolvedValue(empty)
    const got = await waitForSavedRules(read, 'allow', 100, async () => {})
    expect(got.saved).toEqual([])
    expect(read).toHaveBeenCalledTimes(4)
  })
})
