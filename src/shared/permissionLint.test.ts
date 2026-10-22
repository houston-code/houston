import { describe, expect, it } from 'vitest'
import { lintPermissionRules, moveRule } from './permissionLint'
import type { PermissionRule } from './types'

const r = (action: PermissionRule['action'], tool: string, match: string, exact?: boolean): PermissionRule => ({
  action,
  tool,
  match,
  ...(exact ? { exact } : {})
})

describe('lintPermissionRules', () => {
  it('reports nothing for a clean list', () => {
    expect(lintPermissionRules([r('deny', 'run_shell', 'rm *'), r('allow', 'run_shell', 'git *')]).size).toBe(0)
  })

  it('flags an empty pattern, which matches nothing', () => {
    expect(lintPermissionRules([r('allow', 'run_shell', '  ')]).get(0)).toEqual([{ kind: 'empty' }])
  })

  it('flags a later rule a same-tool `*` catches first, as a conflict when the action differs', () => {
    const issues = lintPermissionRules([r('allow', 'run_shell', '*'), r('deny', 'run_shell', 'rm *')])
    expect(issues.get(1)).toEqual([{ kind: 'shadowed', by: 0, conflicting: true }])
  })

  it('flags a duplicate of an earlier rule as redundant, not conflicting', () => {
    const issues = lintPermissionRules([r('ask', 'web_fetch', 'https://a.com/*'), r('ask', 'web_fetch', 'https://a.com/*')])
    expect(issues.get(1)).toEqual([{ kind: 'shadowed', by: 0, conflicting: false }])
  })

  it('treats tool `*` as covering every tool, but not the other way round', () => {
    expect(lintPermissionRules([r('deny', '*', '*'), r('allow', 'read_file', 'src/**')]).get(1)?.[0]).toMatchObject({
      kind: 'shadowed',
      by: 0
    })
    expect(lintPermissionRules([r('deny', 'read_file', '*'), r('allow', '*', 'src/**')]).has(1)).toBe(false)
  })

  it('never treats a different tool as covering', () => {
    expect(lintPermissionRules([r('deny', 'write_file', '*'), r('allow', 'read_file', '*')]).get(1)).toEqual([
      { kind: 'broad-allow' }
    ])
  })

  it('reads an exact `*` as the literal subject, not a catch-all', () => {
    expect(lintPermissionRules([r('deny', 'web_search', '*', true), r('allow', 'web_search', 'cats')]).has(1)).toBe(false)
  })

  it('lets a glob cover an exact rule of the same text, but not the reverse', () => {
    expect(lintPermissionRules([r('deny', 'read_file', 'a.txt'), r('allow', 'read_file', 'a.txt', true)]).has(1)).toBe(true)
    expect(lintPermissionRules([r('deny', 'read_file', 'a.txt', true), r('allow', 'read_file', 'a.txt')]).has(1)).toBe(false)
  })

  it('names the first rule that shadows, once', () => {
    const issues = lintPermissionRules([r('ask', 'glob', '*'), r('deny', 'glob', '*'), r('allow', 'glob', 'x')])
    expect(issues.get(2)).toEqual([{ kind: 'shadowed', by: 0, conflicting: true }])
  })

  it('never lets an earlier empty rule shadow anything, since it matches nothing', () => {
    expect(lintPermissionRules([r('deny', 'run_shell', ''), r('allow', 'run_shell', 'git *')]).has(1)).toBe(false)
  })

  it('reads a blank tool as every tool, and a missing pattern as empty', () => {
    const blankTool = { action: 'deny', tool: '', match: '*' } as PermissionRule
    expect(lintPermissionRules([blankTool, r('allow', 'read_file', 'x')]).get(1)?.[0]).toMatchObject({ kind: 'shadowed', by: 0 })
    expect(lintPermissionRules([r('deny', 'glob', '*'), { action: 'allow', tool: '', match: 'y' } as PermissionRule]).has(1)).toBe(false)
    const noMatch = { action: 'ask', tool: 'glob' } as unknown as PermissionRule
    expect(lintPermissionRules([noMatch]).get(0)).toEqual([{ kind: 'empty' }])
    expect(lintPermissionRules([noMatch, r('ask', 'glob', 'z')]).has(1)).toBe(false)
  })

  it('flags a glob allow of everything as broad', () => {
    expect(lintPermissionRules([r('allow', '*', '*')]).get(0)).toEqual([{ kind: 'broad-allow' }])
    expect(lintPermissionRules([r('allow', '*', '*', true)]).has(0)).toBe(false)
  })
})

describe('moveRule', () => {
  const list = [r('allow', 'a', '1'), r('allow', 'b', '2'), r('allow', 'c', '3')]

  it('moves a rule up and down', () => {
    expect(moveRule(list, 2, 0).map((x) => x.tool)).toEqual(['c', 'a', 'b'])
    expect(moveRule(list, 0, 1).map((x) => x.tool)).toEqual(['b', 'a', 'c'])
  })

  it('returns the list unchanged for a no-op or out-of-range move', () => {
    expect(moveRule(list, 1, 1)).toBe(list)
    expect(moveRule(list, -1, 0)).toBe(list)
    expect(moveRule(list, 0, 3)).toBe(list)
  })
})
