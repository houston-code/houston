import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Count every git process the code under test starts, and how many are the config
// probe that hardens each command.
const h = vi.hoisted(() => ({ calls: [] as string[][] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    execFile: ((file: string, args: string[], ...rest: unknown[]) => {
      if (file === 'git') h.calls.push(args)
      return (real.execFile as (...a: unknown[]) => unknown)(file, args, ...rest)
    }) as typeof real.execFile
  }
})

import { gitContext } from './git'
import { planScope } from './fileScope'
import { hardenedGitArgs, GIT_ENV } from './gitRead'

const probes = (): number => h.calls.filter((a) => a.includes('--show-scope')).length

let repo: string
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'houston-gitprobe-')))
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(repo, '.gitignore'), 'build/\n')
  mkdirSync(join(repo, 'build'))
  writeFileSync(join(repo, 'a.txt'), 'a\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'b.txt'), 'untracked\n')
  h.calls.length = 0
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('git probes per operation', () => {
  it('gitContext probes the config once and says the same as probing per command', async () => {
    const shared = await gitContext(repo)
    expect(probes()).toBe(1)
    // The old behaviour: every command hardened on its own.
    const perCommand = await gitContext(repo, async (args, cwd) => {
      const hardening = await hardenedGitArgs(cwd)
      return execFileSync('git', [...hardening, '--no-pager', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' })
    })
    expect(shared).toBe(perCommand)
    expect(shared).toContain('main')
  })

  it('planScope probes the config once for the whole plan', async () => {
    const plan = await planScope(repo)
    expect(plan).toEqual({ kind: 'git', walk: true, explicit: [] })
    expect(probes()).toBe(1)
    // A folder git ignores but that holds tracked files: the other branch of the plan.
    execFileSync('git', ['add', '-f', 'build'], { cwd: repo })
    writeFileSync(join(repo, 'build', 'kept.js'), '')
    execFileSync('git', ['add', '-f', 'build/kept.js'], { cwd: repo })
    h.calls.length = 0
    const inside = await planScope(join(repo, 'build'))
    expect(inside).toEqual({ kind: 'git', walk: false, explicit: ['kept.js'] })
    expect(probes()).toBe(1)
  })
})
