import { describe, expect, it } from 'vitest'
import { carryRuleMeta, diffRules, parseRulesText, rulesToText } from './permissionRulesText'
import type { PermissionRule } from './types'

const a: PermissionRule = { action: 'allow', tool: 'run_shell', match: 'git *' }
const d: PermissionRule = { action: 'deny', tool: 'run_shell', match: 'rm *' }
const x: PermissionRule = { action: 'allow', tool: 'write_file', match: 'src/*', exact: true }

describe('rulesToText / parseRulesText', () => {
  it('round-trips a list, one rule per line, dropping bookkeeping fields', () => {
    const text = rulesToText([{ ...a, addedAt: 1, source: 'prompt' }, d, x])
    expect(text).toBe(
      '[\n  {"action":"allow","tool":"run_shell","match":"git *"},\n  {"action":"deny","tool":"run_shell","match":"rm *"},\n  {"action":"allow","tool":"write_file","match":"src/*","exact":true}\n]\n'
    )
    expect(parseRulesText(text)).toEqual({ ok: true, rules: [a, d, x] })
  })

  it('round-trips an empty list', () => {
    expect(parseRulesText(rulesToText([]))).toEqual({ ok: true, rules: [] })
  })

  it('reports invalid JSON with the line it broke on', () => {
    const res = parseRulesText('[\n  {"action":"allow","tool":"run_shell","match":"git *"}\n  {"action":"deny"}\n]')
    expect(res).toMatchObject({ ok: false, error: 'This is not valid JSON.', line: 3 })
  })

  it('needs a list', () => {
    expect(parseRulesText('{"action":"allow"}')).toEqual({ ok: false, error: 'Expected a list of rules, inside [ and ].' })
  })

  it('refuses a misspelt field instead of dropping it, naming the rule and its line', () => {
    const res = parseRulesText('[\n  {"action":"deny","tool":"*","match":"*"},\n  {"acton":"deny","tool":"*","match":"x"}\n]')
    expect(res).toEqual({ ok: false, error: 'Rule 2 has an unknown field "acton".', line: 3 })
  })

  it('checks each field', () => {
    const one = (o: object): ReturnType<typeof parseRulesText> => parseRulesText(JSON.stringify([o]))
    expect(one({ action: 'permit', tool: 'x', match: '' })).toMatchObject({ error: 'Rule 1 needs "action": "allow", "ask", or "deny".' })
    expect(one({ action: 'allow', tool: ' ', match: '' })).toMatchObject({ error: 'Rule 1 needs a "tool" (a tool name, or "*" for any).' })
    expect(one({ action: 'allow', tool: 'x', match: 3 })).toMatchObject({ error: 'Rule 1 needs a "match" pattern (a string).' })
    expect(one({ action: 'allow', tool: 'x', match: '', exact: 'yes' })).toMatchObject({ error: 'Rule 1\'s "exact" must be true or false.' })
    expect(one([1])).toMatchObject({ ok: false })
  })

  it('reads braces inside strings as text when finding a rule\'s line', () => {
    const res = parseRulesText('[\n  {"action":"deny","tool":"run_shell","match":"echo {[\\"x"},\n  {"action":"nope","tool":"*","match":"*"}\n]')
    expect(res).toMatchObject({ ok: false, line: 3 })
  })

  it('drops `exact: false` and trims the tool', () => {
    expect(parseRulesText('[{"action":"ask","tool":" glob ","match":"*","exact":false}]')).toEqual({
      ok: true,
      rules: [{ action: 'ask', tool: 'glob', match: '*' }]
    })
  })
})

describe('carryRuleMeta', () => {
  it('keeps when-and-how for rules that survive, stamps new ones, and pairs duplicates in order', () => {
    const prev: PermissionRule[] = [
      { ...a, addedAt: 10, source: 'prompt' },
      { ...a, addedAt: 20, source: 'settings' },
      d
    ]
    expect(carryRuleMeta([d, a, a, x], prev, 99)).toEqual([
      d,
      { ...a, addedAt: 10, source: 'prompt' },
      { ...a, addedAt: 20, source: 'settings' },
      { ...x, addedAt: 99, source: 'settings' }
    ])
  })
})

describe('diffRules', () => {
  it('counts additions and removals by what the matcher reads', () => {
    expect(diffRules([a, d], [a, x])).toEqual({ added: 1, removed: 1, reordered: false })
    expect(diffRules([a, d], [{ ...a, addedAt: 5 }, d])).toEqual({ added: 0, removed: 0, reordered: false })
  })

  it('notices a change of order among the rules both keep', () => {
    expect(diffRules([a, d, x], [d, a])).toEqual({ added: 0, removed: 1, reordered: true })
    expect(diffRules([a, a, d], [a, d, a])).toMatchObject({ reordered: true })
  })
})
