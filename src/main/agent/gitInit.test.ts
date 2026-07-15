import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initGitRepo } from './gitInit'

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Is `dir` inside a git work tree? (the exact check the Changes panel relies on) */
function isRepo(dir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('initGitRepo', () => {
  it('rejects an empty workspace without touching the filesystem', async () => {
    const res = await initGitRepo('')
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('rejects a workspace that does not exist', async () => {
    const res = await initGitRepo(join(tmpdir(), 'houston-gitinit-does-not-exist-xyz'))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  // Spawns 5 real `git` subprocesses (isRepo ×2, initGitRepo's rev-parse + init,
  // ls-files); give it room under full-suite parallelism / contended CI runners so
  // it can't flake on the default 5s timeout (same rationale as git.test.ts).
  it.runIf(hasGit)('initializes a plain directory into a git repo', { timeout: 30_000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitinit-')))
    try {
      writeFileSync(join(dir, 'app.ts'), 'export const x = 1\n')
      expect(isRepo(dir)).toBe(false)

      const res = await initGitRepo(dir)
      expect(res.ok).toBe(true)
      expect(res.alreadyRepo).toBeUndefined()
      expect(existsSync(join(dir, '.git'))).toBe(true)
      expect(isRepo(dir)).toBe(true)

      // The just-written file is now visible as an untracked change (what the panel shows).
      const others = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: dir,
        encoding: 'utf8'
      })
      expect(others).toContain('app.ts')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.runIf(hasGit)('is idempotent on an existing repo (reports alreadyRepo, no error)', { timeout: 30_000 }, async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitinit-')))
    try {
      execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' })
      const res = await initGitRepo(dir)
      expect(res.ok).toBe(true)
      expect(res.alreadyRepo).toBe(true)
      expect(res.error).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
