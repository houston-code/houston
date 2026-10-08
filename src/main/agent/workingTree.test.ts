import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectShipState, collectWorkingTreeChanges } from './workingTree'

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

  it('is carried on the Changes payload', async () => {
    const dir = freshRepo()
    const changes = await collectWorkingTreeChanges(dir)
    expect(changes.isRepo).toBe(true)
    expect(changes.ship).toEqual({ hasCommits: false, remote: null })
  })
})
