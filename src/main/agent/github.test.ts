import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import {
  ghAuthedHosts,
  ghRepoEnv,
  ghRepoKey,
  gitConfigEnv,
  remoteRepoSlug,
  resolveGh,
  runGh,
  githubContext,
  type GhRepoKeyOptions
} from './github'

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
  // `git remote -v` and the gh-resolved listing, as gh reads them.
  const git =
    (remotes: string | null, resolved: string | null = null) =>
    async (args: string[]) =>
      args[0] === 'remote' ? remotes : resolved
  const lines = (...l: string[]) => l.join('\n')
  const key = (remotes: string | null, resolved: string | null = null, opts: GhRepoKeyOptions = {}) =>
    ghRepoKey('/w', { env: {}, authedHosts: async () => ['github.com'], git: git(remotes, resolved), ...opts })
  const forkAndUpstream = lines(
    'origin\thttps://github.com/me/app (fetch)',
    'origin\thttps://github.com/me/app (push)',
    'upstream\tgit@github.com:Acme/App.git (fetch)',
    'upstream\tgit@github.com:Acme/App.git (push)'
  )

  it('keys on the one repository gh would act on: upstream, then github, then origin', async () => {
    expect(await key(forkAndUpstream)).toBe('github.com:acme/app')
    expect(await key('origin\tgit@github.com:acme/app.git (fetch)\n')).toBe('github.com:acme/app')
    expect(
      await key(lines('fork\thttps://github.com/b/app (fetch)', 'github\thttps://github.com/a/app (fetch)', 'origin\thttps://github.com/c/app (fetch)'))
    ).toBe('github.com:a/app')
    // Among names gh doesn't rank, the first listed (git lists them sorted) wins.
    expect(await key(lines('alpha\thttps://github.com/a/app (fetch)', 'beta\thttps://github.com/b/app (fetch)'))).toBe(
      'github.com:a/app'
    )
  })

  it('changes when a remote is repointed, so an earlier grant no longer applies', async () => {
    const a = await key('origin\tgit@github.com:acme/app.git (fetch)')
    const b = await key('origin\tgit@github.com:evil/app.git (fetch)')
    expect(a).not.toBe(b)
  })

  it('follows gh-resolved the way gh does, so setting it changes the key', async () => {
    const origin = 'origin\thttps://github.com/me/proj (fetch)'
    expect(await key(origin)).toBe('github.com:me/proj')
    // `git config remote.origin.gh-resolved other/repo` (or `gh repo set-default`).
    expect(await key(origin, 'remote.origin.gh-resolved other/repo')).toBe('github.com:other/repo')
    expect(await key(origin, 'remote.origin.gh-resolved ghe.example/other/repo')).toBe('github.com:other/repo')
    // `base` picks that remote's own repository, even below a higher-ranked one.
    expect(await key(forkAndUpstream, 'remote.origin.gh-resolved base')).toBe('github.com:me/app')
    // The highest-ranked remote with a value decides; the last value for a remote wins.
    expect(
      await key(forkAndUpstream, lines('remote.origin.gh-resolved base', 'remote.upstream.gh-resolved x/one', 'remote.upstream.gh-resolved x/two'))
    ).toBe('github.com:x/two')
    // A value for a remote that doesn't exist changes nothing.
    expect(await key(origin, 'remote.nope.gh-resolved other/repo')).toBe('github.com:me/proj')
    // A value gh can't read as a repository gets no key (gh refuses it too).
    expect(await key(origin, 'remote.origin.gh-resolved not-a-repo')).toBeNull()
  })

  it('skips remotes on hosts gh is not signed in to, as gh does', async () => {
    const mixed = lines('origin\thttps://github.com/me/app (fetch)', 'upstream\thttps://gitlab.com/them/app (fetch)')
    expect(await key(mixed)).toBe('github.com:me/app')
    const ghe = lines('origin\thttps://github.com/me/app (fetch)', 'upstream\thttps://ghe.example/team/app (fetch)')
    expect(await key(ghe, null, { authedHosts: async () => ['github.com', 'ghe.example'] })).toBe('ghe.example:team/app')
    // GH_HOST narrows to that host, and leaves nothing when no remote is on it.
    expect(await key(ghe, null, { env: { GH_HOST: 'github.com' }, authedHosts: async () => ['github.com', 'ghe.example'] })).toBe(
      'github.com:me/app'
    )
    expect(await key(ghe, null, { env: { GH_HOST: 'other.example' } })).toBeNull()
    // Signed in to one enterprise host only: its remote wins over github.com's.
    expect(await key(ghe, null, { authedHosts: async () => ['ghe.example'] })).toBe('ghe.example:team/app')
  })

  it('translates an SSH host alias the way gh does', async () => {
    const aliased = 'origin\tgit@work-github:Acme/App.git (fetch)'
    const sshHost = async (alias: string) => (alias === 'work-github' ? 'github.com' : alias)
    expect(await key(aliased, null, { sshHost })).toBe('github.com:acme/app')
    // An HTTPS URL is never translated.
    expect(await key('origin\thttps://work-github/acme/app (fetch)', null, { sshHost })).toBeNull()
  })

  it('reads the push URL only when the fetch URL names no repository', async () => {
    expect(await key(lines('origin\t/srv/mirror.git (fetch)', 'origin\thttps://github.com/me/app (push)'))).toBe('github.com:me/app')
    expect(
      await key(lines('origin\thttps://github.com/me/app (fetch)', 'origin\thttps://github.com/evil/app (push)'))
    ).toBe('github.com:me/app')
  })

  it('prefers GH_REPO, which gh honors first', async () => {
    expect(await key(null, null, { env: { GH_REPO: 'Acme/App' } })).toBe('github.com:acme/app')
    expect(await key(null, null, { env: { GH_REPO: 'ghe.example/team/svc' } })).toBe('ghe.example:team/svc')
    expect(await key(null, null, { env: { GH_REPO: 'team/svc', GH_HOST: 'ghe.example' } })).toBe('ghe.example:team/svc')
    expect(await key(forkAndUpstream, 'remote.origin.gh-resolved base', { env: { GH_REPO: 'x/y' } })).toBe('github.com:x/y')
  })

  it('is null outside a repository or with no GitHub remote', async () => {
    expect(await key(null)).toBeNull()
    expect(await key('')).toBeNull()
    expect(await key('origin\t/srv/git/app.git (fetch)')).toBeNull()
    expect(await key('origin\thttps://github.com/me/a:b (fetch)')).toBeNull()
  })

  it('reads a real checkout, gh-resolved included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-repo-key-'))
    try {
      const run = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
      run('init', '-q')
      run('remote', 'add', 'origin', 'https://github.com/me/proj.git')
      const opts = { env: {}, authedHosts: async () => ['github.com'] }
      expect(await ghRepoKey(dir, opts)).toBe('github.com:me/proj')
      run('config', 'remote.origin.gh-resolved', 'other/repo')
      expect(await ghRepoKey(dir, opts)).toBe('github.com:other/repo')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ghRepoEnv', () => {
  it('names the keyed repository with its host, for GH_REPO', () => {
    expect(ghRepoEnv('github.com:me/proj')).toEqual({ GH_REPO: 'github.com/me/proj' })
    expect(ghRepoEnv('ghe.example:team/svc')).toEqual({ GH_REPO: 'ghe.example/team/svc' })
  })

  it('reaches gh through runGh, over a GH_REPO already in the environment', async () => {
    // Node stands in for gh and reports the GH_REPO it was started with.
    const r = await runGh(process.execPath)(
      ['-e', 'console.log(process.env.GH_REPO)'],
      process.cwd(),
      undefined,
      ghRepoEnv('github.com:me/proj')
    )
    expect(r.stdout.trim()).toBe('github.com/me/proj')
  })
})

describe('ghAuthedHosts', () => {
  it("lists hosts.yml's top-level hosts and nothing under them", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-config-'))
    try {
      writeFileSync(
        join(dir, 'hosts.yml'),
        'github.com:\n    oauth_token: gho_x\n    user: me\nGHE.Example:\n    git_protocol: ssh\n"quoted.example":\n'
      )
      expect(await ghAuthedHosts({ GH_CONFIG_DIR: dir })).toEqual(['github.com', 'ghe.example', 'quoted.example'])
      expect(await ghAuthedHosts({ GH_CONFIG_DIR: join(dir, 'missing') })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
