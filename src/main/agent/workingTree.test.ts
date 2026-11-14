import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectShipState,
  collectWorkingTreeChanges,
  collectWorkingTreeStats,
  ghHostsFile,
  knownGithubHosts,
  sumNumstat,
  workingTreeFingerprint
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

  maybe('fingerprints the working tree: stable when untouched, changed by any edit', async () => {
    const repo = initRepo()
    const outside = mkdtempSync(join(tmpdir(), 'wtf-'))
    try {
      const clean = await workingTreeFingerprint(repo)
      expect(clean).not.toBeNull()
      expect(await workingTreeFingerprint(repo)).toBe(clean)

      // Editing a tracked file changes it.
      writeFileSync(join(repo, 'README.md'), '# edited\n')
      const dirty = await workingTreeFingerprint(repo)
      expect(dirty).not.toBe(clean)

      // A further edit to an already-dirty file changes it again, though the
      // status listing stays the same.
      writeFileSync(join(repo, 'README.md'), '# edited again, longer\n')
      const dirtier = await workingTreeFingerprint(repo)
      expect(dirtier).not.toBe(dirty)

      // A new untracked file changes it; an ignored one doesn't.
      writeFileSync(join(repo, '.gitignore'), 'ignored.txt\n')
      const withIgnoreFile = await workingTreeFingerprint(repo)
      expect(withIgnoreFile).not.toBe(dirtier)
      writeFileSync(join(repo, 'ignored.txt'), 'x\n')
      expect(await workingTreeFingerprint(repo)).toBe(withIgnoreFile)

      // Committing everything changes it (HEAD moved, tree is clean again).
      git(repo, 'add', '-A')
      git(repo, '-c', 'commit.gpgsign=false', 'commit', '-m', 'more')
      expect(await workingTreeFingerprint(repo)).not.toBe(withIgnoreFile)

      // Outside a repo there is no fingerprint.
      expect(await workingTreeFingerprint(outside)).toBeNull()
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }, TIMEOUT)

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

describe('sumNumstat', () => {
  it('sums plain, binary, and rename records', () => {
    const out = [
      '3\t1\ta.txt',
      '-\t-\tbin.dat',
      '2\t2\t',
      'old name.txt',
      'new name.txt',
      '0\t4\tgone.txt',
      ''
    ].join('\0')
    expect(sumNumstat(out)).toEqual({ files: 4, added: 5, removed: 7 })
  })

  it('reads an empty listing as no changes', () => {
    expect(sumNumstat('')).toEqual({ files: 0, added: 0, removed: 0 })
  })
})

describe.skipIf(!hasGit)('collectWorkingTreeStats', () => {
  // Each case runs both collectors over real git, which is slow on a loaded machine.
  const GIT_TIMEOUT = 30_000

  /** What the badge would compute from the full change set. */
  async function fromFull(dir: string): Promise<unknown> {
    const full = await collectWorkingTreeChanges(dir)
    return full.isRepo
      ? {
          isRepo: true,
          branch: full.branch,
          fileCount: full.files.length,
          added: full.added,
          removed: full.removed,
          ship: full.ship
        }
      : { isRepo: false, branch: null, fileCount: 0, added: 0, removed: 0 }
  }

  it('matches the full change set for modified, added, deleted, renamed, binary and untracked files', async () => {
    const dir = freshRepo()
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n'
    writeFileSync(join(dir, 'mod.txt'), 'one\ntwo\nthree\nfour\n')
    writeFileSync(join(dir, 'del.txt'), 'gone\nsoon\n')
    writeFileSync(join(dir, 'old name.txt'), body)
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 5]))
    writeFileSync(join(dir, 'run.sh'), 'echo hi\n')
    commit(dir)

    // A mode-only change: a file entry with no hunks (POSIX only; Windows ignores modes).
    if (process.platform !== 'win32') chmodSync(join(dir, 'run.sh'), 0o755)
    writeFileSync(join(dir, 'mod.txt'), 'one\n2\nthree\nfour\nfive\n')
    unlinkSync(join(dir, 'del.txt'))
    git(dir, 'mv', 'old name.txt', 'new name.txt')
    writeFileSync(join(dir, 'new name.txt'), body.replace('line 7\n', 'line seven\n'))
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 5, 6]))
    writeFileSync(join(dir, 'staged.txt'), 'a\nb\nc\n')
    git(dir, 'add', 'staged.txt', 'new name.txt')
    // Untracked: plain, no trailing newline, leading blank line, empty, and binary.
    writeFileSync(join(dir, 'notes.txt'), 'x\ny\n')
    writeFileSync(join(dir, 'no-eol.txt'), 'p\nq')
    writeFileSync(join(dir, 'blank-first.txt'), '\nafter\n')
    writeFileSync(join(dir, 'empty.txt'), '')
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([7, 0, 7]))

    const full = await collectWorkingTreeChanges(dir)
    // The fixture really exercises each kind of change the counts must agree on.
    const statuses = new Set(full.files.map((f) => f.status))
    for (const s of ['modified', 'added', 'deleted', 'renamed', 'untracked'] as const) {
      expect(statuses).toContain(s)
    }
    expect(full.files.some((f) => f.binary && f.status === 'modified')).toBe(true)

    const stats = await collectWorkingTreeStats(dir)
    expect(stats).toEqual(await fromFull(dir))
    expect(stats.fileCount).toBe(full.files.length)
    expect(stats.added).toBeGreaterThan(0)
    expect(stats.removed).toBeGreaterThan(0)
  }, GIT_TIMEOUT)

  it('matches on an unborn HEAD with staged and untracked files', async () => {
    const dir = freshRepo()
    writeFileSync(join(dir, 'b.txt'), 'one\ntwo\n')
    git(dir, 'add', 'b.txt')
    expect(await collectWorkingTreeStats(dir)).toEqual(await fromFull(dir))
  }, GIT_TIMEOUT)

  it('matches on a clean tree and reports a non-repo as such', async () => {
    const dir = freshRepo()
    commit(dir)
    expect(await collectWorkingTreeStats(dir)).toEqual(await fromFull(dir))

    const plain = mkdtempSync(join(tmpdir(), 'houston-plain-'))
    dirs.push(plain)
    expect(await collectWorkingTreeStats(plain)).toEqual({
      isRepo: false,
      branch: null,
      fileCount: 0,
      added: 0,
      removed: 0
    })
  }, GIT_TIMEOUT)
})

describe.skipIf(!hasGit)('a repository git cannot open', () => {
  /** A linked worktree whose admin `commondir` file is gone, so git can't open it. */
  function brokenWorktree(): string {
    const dir = freshRepo()
    commit(dir)
    const wt = join(dir, 'wt')
    git(dir, 'worktree', 'add', '-q', wt)
    rmSync(join(dir, '.git', 'worktrees', 'wt', 'commondir'))
    return wt
  }

  it('is reported with git\'s reason, in the full set and the badge counts', async () => {
    const wt = brokenWorktree()
    const changes = await collectWorkingTreeChanges(wt)
    expect(changes.isRepo).toBe(false)
    // git's wording varies by version ("not a git repository", "gitfile does not point to a
    // valid repository"); either way it is git's reason, without the fatal: prefix.
    expect(changes.unreadable).toMatch(/repositor/)
    expect(changes.unreadable).not.toMatch(/^fatal:/)
    const stats = await collectWorkingTreeStats(wt)
    expect(stats).toMatchObject({ isRepo: false, unreadable: changes.unreadable })
  })

  it('is not claimed for a plain folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-plain-'))
    dirs.push(dir)
    const changes = await collectWorkingTreeChanges(dir)
    expect(changes.isRepo).toBe(false)
    expect(changes.unreadable).toBeUndefined()
  })
})
