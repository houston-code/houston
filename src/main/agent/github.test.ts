import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { gitConfigEnv, resolveGh, runGh, githubContext } from './github'

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
      env: { HOUSTON_GH: '/missing/gh', PATH: '/a:/b' },
      exists: has(['/b/gh']),
      platform: 'linux'
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
      exists: has([win32.join(dir, 'gh.exe')])
    })
    expect(got).toBe(win32.join(dir, 'gh.exe'))
  })
})

describe('runGh', () => {
  it('maps a successful command to ok + stdout', async () => {
    // Node stands in for gh: a real binary on every platform that exits 0 with stdout.
    const r = await runGh(process.execPath)(['-e', 'console.log("hello world")'], process.cwd())
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
    const r = await runGh(process.execPath)(['-e', 'process.exit(3)'], process.cwd())
    expect(r.ok).toBe(false)
    expect(r.code).toBe(3)
  })
})

describe('githubContext', () => {
  it('advertises the PR, issue, CI-run, and repo tools when gh is present', () => {
    const ctx = githubContext(() => '/opt/homebrew/bin/gh')
    expect(ctx).toContain('gh_pr_create')
    expect(ctx).toContain('gh_pr_checks')
    expect(ctx).toContain('gh_pr_review')
    expect(ctx).toContain('gh_pr_merge')
    expect(ctx).toContain('gh_pr_set_state')
    expect(ctx).toContain('gh_issue_create')
    expect(ctx).toContain('gh_issue_set_state')
    expect(ctx).toContain('gh_run_view')
    expect(ctx).toContain('gh_repo_create')
    expect(ctx).toContain('gh auth login')
  })

  it('returns empty when gh is absent (no section, no network probe)', () => {
    expect(githubContext(() => null)).toBe('')
  })
})

describe('gh git hardening', () => {
  it('turns -c pairs into GIT_CONFIG_* entries after any already set', () => {
    const env = gitConfigEnv(['-c', 'core.hooksPath=/dev/null', '-c', 'filter.x.clean='], {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'me'
    })
    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/dev/null',
      GIT_CONFIG_KEY_2: 'filter.x.clean',
      GIT_CONFIG_VALUE_2: ''
    })
  })

  it('is read by git as config', () => {
    let out: string
    try {
      out = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        env: gitConfigEnv(['-c', 'core.hooksPath=/dev/null'], process.env),
        encoding: 'utf8'
      })
    } catch {
      return // git not installed here
    }
    expect(out.trim()).toBe('/dev/null')
  })

  it('hands gh the hardening its git subprocesses inherit', async () => {
    const r = await runGh(process.execPath)(
      ['-e', 'const e = process.env; const n = +e.GIT_CONFIG_COUNT; for (let i = 0; i < n; i++) console.log(e["GIT_CONFIG_KEY_" + i] + "=" + e["GIT_CONFIG_VALUE_" + i])'],
      process.cwd()
    )
    expect(r.ok).toBe(true)
    expect(r.stdout.split('\n')).toEqual(
      expect.arrayContaining(['core.hooksPath=/dev/null', 'core.fsmonitor=', 'log.showSignature=false'])
    )
  })
})
