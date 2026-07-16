import { describe, expect, it } from 'vitest'
import { delimiter, join } from 'node:path'
import { resolveGh, runGh, githubContext } from './github'

describe('resolveGh', () => {
  const has = (set: string[]) => (p: string) => set.includes(p)

  it('prefers the HOUSTON_GH override when it exists', () => {
    const got = resolveGh({
      env: { HOUSTON_GH: '/custom/gh', PATH: '/usr/bin' },
      exists: has(['/custom/gh', '/usr/bin/gh'])
    })
    expect(got).toBe('/custom/gh')
  })

  it('ignores the override when it does not exist and falls back to PATH', () => {
    const got = resolveGh({
      env: { HOUSTON_GH: '/missing/gh', PATH: ['/a', '/b'].join(delimiter) },
      exists: has(['/b/gh'])
    })
    expect(got).toBe('/b/gh')
  })

  it('falls back to known install dirs when PATH misses', () => {
    const got = resolveGh({ env: { PATH: '/nowhere' }, exists: has(['/opt/homebrew/bin/gh']) })
    expect(got).toBe('/opt/homebrew/bin/gh')
  })

  it('returns null when gh is nowhere', () => {
    expect(resolveGh({ env: { PATH: '/nowhere' }, exists: () => false })).toBeNull()
  })

  it('looks for gh.exe on PATH on Windows', () => {
    const dir = 'C:\\tools'
    const got = resolveGh({
      platform: 'win32',
      env: { PATH: dir },
      exists: has([join(dir, 'gh.exe')])
    })
    expect(got).toBe(join(dir, 'gh.exe'))
  })
})

describe('runGh', () => {
  it('maps a successful command to ok + stdout', async () => {
    // /bin/echo stands in for gh: a real binary that exits 0 with stdout.
    const r = await runGh('/bin/echo')(['hello world'], process.cwd())
    expect(r.ok).toBe(true)
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('hello world')
  })

  it('maps a missing binary to ok:false without throwing', async () => {
    const r = await runGh('/definitely/not/a/real/binary-xyz')(['pr', 'list'], process.cwd())
    expect(r.ok).toBe(false)
    expect(r.code).toBeNull()
  })

  it('maps a non-zero exit to ok:false with a numeric code', async () => {
    const r = await runGh('/bin/sh')(['-c', 'exit 3'], process.cwd())
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
  })
})

describe('githubContext', () => {
  it('advertises the PR, issue, CI-run, and repo tools when gh is present', () => {
    const ctx = githubContext(() => '/opt/homebrew/bin/gh')
    expect(ctx).toContain('gh_pr_create')
    expect(ctx).toContain('gh_pr_checks')
    expect(ctx).toContain('gh_issue_create')
    expect(ctx).toContain('gh_run_view')
    expect(ctx).toContain('gh_repo_create')
    expect(ctx).toContain('gh auth login')
  })

  it('returns empty when gh is absent (no section, no network probe)', () => {
    expect(githubContext(() => null)).toBe('')
  })
})
