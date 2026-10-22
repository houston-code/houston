import { describe, expect, it } from 'vitest'
import { daysAgo, ruleMetaText, testVerdictText } from './ruleMeta'

const DAY = 24 * 60 * 60 * 1000
const now = Date.UTC(2026, 9, 22, 12)

describe('daysAgo', () => {
  it('reads in days, then months, then years', () => {
    expect(daysAgo(now - 1000, now)).toBe('today')
    expect(daysAgo(now - DAY, now)).toBe('yesterday')
    expect(daysAgo(now - 5 * DAY, now)).toBe('5 days ago')
    expect(daysAgo(now - 90 * DAY, now)).toBe('3 months ago')
    expect(daysAgo(now - 800 * DAY, now)).toBe('2 years ago')
  })

  it('never reads a future time as negative', () => {
    expect(daysAgo(now + DAY, now)).toBe('today')
  })
})

describe('ruleMetaText', () => {
  const rule = { action: 'allow' as const, tool: 'run_shell', match: 'git *' }

  it('says when and how a rule was added and when it was last used', () => {
    expect(ruleMetaText({ ...rule, addedAt: now - 3 * DAY, source: 'prompt' }, now - DAY, now)).toBe(
      'Added 3 days ago from an approval prompt · last used yesterday'
    )
  })

  it('says "not used yet" only when the rule has a known creation date', () => {
    expect(ruleMetaText({ ...rule, addedAt: now - 2 * DAY, source: 'settings' }, undefined, now)).toBe(
      'Added 2 days ago in Settings · not used yet'
    )
    expect(ruleMetaText(rule, undefined, now)).toBe('')
    expect(ruleMetaText(rule, now - 5 * DAY, now)).toBe('Last used 5 days ago')
  })
})

describe('testVerdictText', () => {
  it('names the deciding tier', () => {
    expect(testVerdictText({ decision: 'deny', tier: 'managed', userMatches: [] }, [], 'ask')).toBe(
      'Deny, decided by the administrator policy.'
    )
    expect(testVerdictText({ decision: 'ask', tier: 'project', userMatches: [] }, [], 'ask')).toBe(
      "Ask, decided by this project's guardrails."
    )
    expect(testVerdictText({ decision: 'allow', tier: 'project-allow', userMatches: [] }, [], 'ask')).toBe(
      "Allow, decided by this project's allow rules."
    )
  })

  it('names the deciding rule (the first match with the verdict) and lists the others', () => {
    const rules = [
      { action: 'allow' as const, tool: 'run_shell', match: 'git *' },
      { action: 'allow' as const, tool: 'run_shell', match: '*' },
      { action: 'deny' as const, tool: 'run_shell', match: 'rm *' }
    ]
    expect(testVerdictText({ decision: 'allow', tier: 'user', userMatches: [1] }, rules, 'ask')).toBe(
      'Allow, decided by your rule 2.'
    )
    expect(testVerdictText({ decision: 'allow', tier: 'user', userMatches: [1, 2] }, rules, 'ask')).toBe(
      'Allow, decided by your rule 2. Also matching: rule 3.'
    )
    // A compound command one part of which is denied: the deny decides.
    expect(testVerdictText({ decision: 'deny', tier: 'user', userMatches: [0, 1, 2] }, rules, 'ask')).toBe(
      'Deny, decided by your rule 3. Also matching: rules 1, 2.'
    )
  })

  it('falls back to the approval mode when nothing matches', () => {
    expect(testVerdictText({ decision: null, tier: null, userMatches: [] }, [], 'auto-edit')).toBe(
      "No rule matches, so the chat's approval mode decides (new chats start in Auto-approve edits)."
    )
  })
})
