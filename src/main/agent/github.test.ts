import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { ghRepoKey, gitConfigEnv, remoteRepoSlug, resolveGh, runGh, githubContext } from './github'

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

describe('remoteRepoSlug', () => {
  it('reads host and owner/repo from the usual remote URL shapes, lowercased', () => {
    expect(remoteRepoSlug('git@github.com:Acme/App.git')).toBe('github.com:acme/app')
    expect(remoteRepoSlug('https://github.com/acme/app')).toBe('github.com:acme/app')
    expect(remoteRepoSlug('https://github.com/acme/app.git/')).toBe('github.com:acme/app')
    expect(remoteRepoSlug('ssh://git@ghe.corp.example:2222/team/svc.git')).toBe('ghe.corp.example:team/svc')
    expect(remoteRepoSlug('git://github.com/acme/app.git')).toBe('github.com:acme/app')
  })

  it('drops credentials embedded in the URL', () => {
    expect(remoteRepoSlug('https://x-access-token:ghs_secret@github.com/acme/app.git')).toBe('github.com:acme/app')
  })

  it('returns null for a URL that names no repository', () => {
    expect(remoteRepoSlug('/srv/git/app.git')).toBeNull()
    expect(remoteRepoSlug('file:///srv/git/acme/app.git')).toBeNull()
    expect(remoteRepoSlug('https://github.com/acme')).toBeNull()
    expect(remoteRepoSlug('https://example.com/a/b/c')).toBeNull()
    expect(remoteRepoSlug('')).toBeNull()
  })
})

describe('ghRepoKey', () => {
  const git = (out: string | null) => async () => out

  it('keys on every repository the remotes point at, sorted', async () => {
    const remotes = [
      'upstream\tgit@github.com:Acme/App.git (fetch)',
      'upstream\tgit@github.com:Acme/App.git (push)',
      'origin\thttps://github.com/me/app (fetch)',
      'origin\thttps://github.com/me/app (push)'
    ].join('\n')
    expect(await ghRepoKey('/w', {}, git(remotes))).toBe('github.com:acme/app,me/app')
    expect(await ghRepoKey('/w', {}, git('origin\tgit@github.com:acme/app.git (fetch)\n'))).toBe('github.com:acme/app')
  })

  it('changes when a remote is repointed, so an earlier grant no longer applies', async () => {
    const a = await ghRepoKey('/w', {}, git('origin\tgit@github.com:acme/app.git (fetch)'))
    const b = await ghRepoKey('/w', {}, git('origin\tgit@github.com:evil/app.git (fetch)'))
    expect(a).not.toBe(b)
  })

  it('prefers GH_REPO, which gh honors first', async () => {
    expect(await ghRepoKey('/w', { GH_REPO: 'Acme/App' }, git(null))).toBe('github.com:acme/app')
    expect(await ghRepoKey('/w', { GH_REPO: 'ghe.example/team/svc' }, git(null))).toBe('ghe.example:team/svc')
  })

  it('is null outside a repository or with no GitHub-shaped remote', async () => {
    expect(await ghRepoKey('/w', {}, git(null))).toBeNull()
    expect(await ghRepoKey('/w', {}, git(''))).toBeNull()
    expect(await ghRepoKey('/w', {}, git('origin\t/srv/git/app.git (fetch)'))).toBeNull()
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
