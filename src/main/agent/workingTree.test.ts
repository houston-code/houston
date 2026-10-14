import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectShipState,
  collectWorkingTreeChanges,
  ghHostsFile,
  knownGithubHosts
} from './workingTree'

// Real git in a temp dir: the branch label and diff base depend on how git resolves
// HEAD in each state, which a mocked runner can't vouch for.
describe('collectWorkingTreeChanges (real git)', () => {
  let gitOk = true
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    gitOk = false
  }
  const maybe = gitOk ? it : it.skip
  const TIMEOUT = 30_000

  const git = (repo: string, ...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  }

  /** A fresh repo on `branch` with no commits (unborn HEAD). */
  function initUnborn(branch: string): string {
    const repo = mkdtempSync(join(tmpdir(), 'wtc-'))
    git(repo, '-c', `init.defaultBranch=${branch}`, 'init')
    git(repo, 'config', 'user.email', 't@t.t')
    git(repo, 'config', 'user.name', 'Test')
    return repo
  }

  /** A repo on `main` with one commit. */
  function initRepo(): string {
    const repo = initUnborn('main')
    writeFileSync(join(repo, 'README.md'), '# repo\n')
    git(repo, 'add', 'README.md')
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'init')
    return repo
  }

  maybe('names the unborn branch of a repo with no commits', async () => {
    const repo = initUnborn('master')
    try {
      writeFileSync(join(repo, 'a.txt'), 'hello\n')
      const res = await collectWorkingTreeChanges(repo)
      expect(res.isRepo).toBe(true)
      expect(res.branch).toBe('master')
      expect(res.files.map((f) => f.path)).toContain('a.txt')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)

  maybe('includes staged files in a repo with no commits', async () => {
    const repo = initUnborn('main')
    try {
      writeFileSync(join(repo, 'staged.txt'), 'fresh\n')
      git(repo, 'add', 'staged.txt')
      const res = await collectWorkingTreeChanges(repo)
      expect(res.files.map((f) => f.path)).toContain('staged.txt')
      expect(res.added).toBeGreaterThan(0)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)

  maybe('names the current branch of a normal repo', async () => {
    const repo = initRepo()
    try {
      const res = await collectWorkingTreeChanges(repo)
      expect(res.branch).toBe('main')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)

  maybe('reports null (not the literal "HEAD") for a detached HEAD', async () => {
    const repo = initRepo()
    try {
      git(repo, 'checkout', '--detach', '-q')
      const res = await collectWorkingTreeChanges(repo)
      expect(res.isRepo).toBe(true)
      expect(res.branch).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, TIMEOUT)
})

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A fresh `git init` (unborn HEAD, no remotes) with one untracked file. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'houston-ship-'))
  dirs.push(dir)
  git(dir, 'init', '-q')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  return dir
}

function commit(dir: string): void {
  git(dir, 'add', '-A')
  git(
    dir,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'init'
  )
}

describe.skipIf(!hasGit)('collectShipState', () => {
  it('reports no commits and no remote for a fresh git init', async () => {
    const dir = freshRepo()
    expect(await collectShipState(dir)).toEqual({ hasCommits: false, remote: null })
  })

  it('reports commits once HEAD exists', async () => {
    const dir = freshRepo()
    commit(dir)
    expect(await collectShipState(dir)).toEqual({ hasCommits: true, remote: null })
  })

  it('prefers origin and classifies a GitHub URL without returning it', async () => {
    const dir = freshRepo()
    git(dir, 'remote', 'add', 'backup', 'https://gitlab.com/acme/app.git')
    git(dir, 'remote', 'add', 'origin', 'https://x-access-token:SECRET@github.com/acme/app.git')
    const state = await collectShipState(dir)
    expect(state.remote).toEqual({ name: 'origin', host: 'github' })
    expect(JSON.stringify(state)).not.toContain('SECRET')
  })

  it('falls back to the first remote when there is no origin', async () => {
    const dir = freshRepo()
    git(dir, 'remote', 'add', 'gl', 'git@gitlab.com:acme/app.git')
    expect((await collectShipState(dir)).remote).toEqual({ name: 'gl', host: 'other' })
  })

  it('classifies a GitHub Enterprise remote as GitHub when gh is signed in to it', async () => {
    const dir = freshRepo()
    git(dir, 'remote', 'add', 'origin', 'git@github.acme.corp:team/app.git')
    expect((await collectShipState(dir, ['github.acme.corp'])).remote).toEqual({
      name: 'origin',
      host: 'github'
    })
    expect((await collectShipState(dir, [])).remote).toEqual({ name: 'origin', host: 'other' })
  })

  it('is carried on the Changes payload', async () => {
    const dir = freshRepo()
    const changes = await collectWorkingTreeChanges(dir)
    expect(changes.isRepo).toBe(true)
    expect(changes.ship).toEqual({ hasCommits: false, remote: null })
  })
})

describe('knownGithubHosts', () => {
  const HOSTS_YML = [
    'github.com:',
    '    users:',
    '        octo:',
    '            oauth_token: gho_secret',
    '    git_protocol: ssh',
    '    user: octo',
    'GitHub.Acme.Corp:',
    '    oauth_token: ghp_other',
    '# comment.example:',
    ''
  ].join('\n')

  it('reads the top-level host keys of gh hosts.yml, lowercased', () => {
    const hosts = knownGithubHosts({ GH_CONFIG_DIR: '/cfg' }, (p) =>
      p === join('/cfg', 'hosts.yml') ? HOSTS_YML : null
    )
    expect(hosts.sort()).toEqual(['github.acme.corp', 'github.com'])
    expect(hosts.join(' ')).not.toMatch(/gho_|ghp_|octo/)
  })

  it('adds GH_HOST, and survives a missing file', () => {
    expect(knownGithubHosts({ GH_HOST: ' GHE.Example.Com ' }, () => null)).toEqual(['ghe.example.com'])
    expect(knownGithubHosts({}, () => null)).toEqual([])
  })
})

describe('ghHostsFile', () => {
  it('follows gh config-dir precedence', () => {
    expect(ghHostsFile({ GH_CONFIG_DIR: '/a', XDG_CONFIG_HOME: '/b' }, 'linux', '/h')).toBe(
      join('/a', 'hosts.yml')
    )
    expect(ghHostsFile({ XDG_CONFIG_HOME: '/b' }, 'linux', '/h')).toBe(join('/b', 'gh', 'hosts.yml'))
    expect(ghHostsFile({ AppData: 'C:/Users/me/AppData/Roaming' }, 'win32', '/h')).toBe(
      join('C:/Users/me/AppData/Roaming', 'GitHub CLI', 'hosts.yml')
    )
    expect(ghHostsFile({}, 'darwin', '/h')).toBe(join('/h', '.config', 'gh', 'hosts.yml'))
  })
})
