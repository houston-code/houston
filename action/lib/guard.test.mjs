import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPushTarget,
  capBody,
  changedControlFiles,
  containsSecret,
  fixBranchName,
  logSafe,
  secretValues,
  snapshotGitControl
} from './guard.mjs'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'h-guard-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  return dir
}

describe('snapshotGitControl', () => {
  it('is stable when nothing changes', () => {
    const dir = repo()
    expect(changedControlFiles(snapshotGitControl(dir), snapshotGitControl(dir))).toEqual([])
  })

  it('catches a config edit, a new hook, and new attributes', () => {
    const dir = repo()
    const before = snapshotGitControl(dir)
    execFileSync('git', ['config', 'core.fsmonitor', 'touch /tmp/pwned'], { cwd: dir })
    writeFileSync(join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\necho hi\n')
    mkdirSync(join(dir, '.git/info'), { recursive: true })
    writeFileSync(join(dir, '.git/info/attributes'), '* filter=evil\n')
    expect(changedControlFiles(before, snapshotGitControl(dir))).toEqual(['config', 'hooks/pre-commit', 'info/attributes'])
  })

  it('catches the hooks directory swapped for a symlink, without following it', () => {
    const dir = repo()
    const before = snapshotGitControl(dir)
    const elsewhere = mkdtempSync(join(tmpdir(), 'h-hooks-'))
    rmSync(join(dir, '.git/hooks'), { recursive: true, force: true })
    symlinkSync(elsewhere, join(dir, '.git/hooks'))
    expect(changedControlFiles(before, snapshotGitControl(dir))).toContain('hooks')
  })

  it('refuses a checkout whose .git is not a directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h-guard-'))
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere\n')
    expect(() => snapshotGitControl(dir)).toThrow(/not a plain git checkout/)
  })
})

describe('secrets', () => {
  it('collects credential-shaped env values and explicit extras', () => {
    const env = { OPENAI_API_KEY: 'sk-abcdefgh123', GH_TOKEN: 'ghs_123456789', PATH: '/usr/bin', SHORT_TOKEN: 'abc', SSH_AUTH_SOCK: '/tmp/agent.sock' }
    const values = secretValues(env, ['explicit-secret-1'])
    expect(values).toEqual(expect.arrayContaining(['sk-abcdefgh123', 'ghs_123456789', 'explicit-secret-1']))
    expect(values).not.toContain('/usr/bin')
    expect(values).not.toContain('abc')
    expect(values).not.toContain('/tmp/agent.sock')
  })

  it('finds a secret anywhere in the text', () => {
    expect(containsSecret('key is sk-abcdefgh123!', ['sk-abcdefgh123'])).toBe(true)
    expect(containsSecret('nothing here', ['sk-abcdefgh123'])).toBe(false)
  })
})

describe('logSafe', () => {
  it('breaks workflow commands and flattens lines', () => {
    expect(logSafe('::add-mask::x\n::error::y')).toBe(': :add-mask: :x : :error: :y')
    expect(logSafe('a'.repeat(3000))).toHaveLength(2000)
  })
})

describe('fix branches', () => {
  it('names the branch from the run id and attempt only', () => {
    expect(fixBranchName('houston/', 77, 2)).toBe('houston/fix-ci-77-2')
  })

  it.each(['', 'houston', '../x/', 'a b/', 'refs/heads/main;/'])('refuses prefix %j', (prefix) => {
    expect(() => fixBranchName(prefix, 1, 1)).toThrow(/branch-prefix/)
  })

  it('never pushes the default or failed branch, or outside the prefix', () => {
    const o = { prefix: 'houston/', defaultBranch: 'main', failedBranch: 'feature' }
    expect(() => assertPushTarget('houston/fix-ci-1-1', o)).not.toThrow()
    expect(() => assertPushTarget('main', o)).toThrow(/not under houston/)
    expect(() => assertPushTarget('houston/x', { ...o, defaultBranch: 'houston/x' })).toThrow(/refusing to push/)
    expect(() => assertPushTarget('houston/x', { ...o, failedBranch: 'houston/x' })).toThrow(/refusing to push/)
  })
})

describe('capBody', () => {
  it('truncates past the comment limit', () => {
    expect(capBody('x'.repeat(70000))).toMatch(/\(truncated\)$/)
    expect(capBody('short')).toBe('short')
  })
})
