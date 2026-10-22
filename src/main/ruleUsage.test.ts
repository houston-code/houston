import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { permissionRuleKey, type PermissionRule } from '@shared/types'
import { flushRuleUsage, getRuleUsage, mergeUsage, noteRuleUsed, resetRuleUsageForTests } from './ruleUsage'
import { resetUserDataDir, setUserDataDir } from './userData'

const rule: PermissionRule = { action: 'allow', tool: 'run_shell', match: 'git status' }

describe('rule usage', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rule-usage-'))
    setUserDataDir(dir)
  })
  afterEach(() => {
    resetRuleUsageForTests()
    resetUserDataDir()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a use under the rule key, readable before and after the flush', () => {
    noteRuleUsed(rule, 1000)
    expect(getRuleUsage()).toEqual({ [permissionRuleKey(rule)]: 1000 })
    flushRuleUsage()
    expect(JSON.parse(readFileSync(join(dir, 'rule-usage.json'), 'utf8'))).toEqual({ [permissionRuleKey(rule)]: 1000 })
    if (process.platform !== 'win32') expect(statSync(join(dir, 'rule-usage.json')).mode & 0o777).toBe(0o600)
  })

  it('ignores bookkeeping fields when keying, so a stamped rule matches its plain self', () => {
    noteRuleUsed({ ...rule, addedAt: 5, source: 'prompt' }, 2000)
    expect(getRuleUsage()[permissionRuleKey(rule)]).toBe(2000)
  })

  it('merges with what another process wrote, keeping the latest time per rule', () => {
    const other: PermissionRule = { action: 'deny', tool: 'web_fetch', match: 'https://x/*' }
    writeFileSync(
      join(dir, 'rule-usage.json'),
      JSON.stringify({ [permissionRuleKey(rule)]: 5000, [permissionRuleKey(other)]: 10 })
    )
    noteRuleUsed(rule, 3000)
    flushRuleUsage()
    expect(getRuleUsage()).toEqual({ [permissionRuleKey(rule)]: 5000, [permissionRuleKey(other)]: 10 })
  })

  it('reads a corrupt or wrong-shaped file as empty, and drops non-numeric entries', () => {
    writeFileSync(join(dir, 'rule-usage.json'), '{not json')
    expect(getRuleUsage()).toEqual({})
    writeFileSync(join(dir, 'rule-usage.json'), JSON.stringify({ a: 'x', b: 7 }))
    expect(getRuleUsage()).toEqual({ b: 7 })
  })

  it('caps the stored keys, keeping the most recent', () => {
    const many = Object.fromEntries(Array.from({ length: 2005 }, (_, i) => [`k${i}`, i]))
    const merged = mergeUsage(many, {})
    expect(Object.keys(merged)).toHaveLength(2000)
    expect(merged.k0).toBeUndefined()
    expect(merged.k2004).toBe(2004)
  })
})
