import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectWorkingTreeChanges } from './workingTree'

// Real git in a temp dir: the branch label depends on how git itself resolves
// HEAD in each state, which a mocked runner can't vouch for.
describe('collectWorkingTreeChanges branch (real git)', () => {
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
