import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatGitContext,
  formatWorktreeContext,
  gitContext,
  gitDiff,
  isSafeGitRef,
  parseWorktreePorcelain,
} from './git'

describe('formatGitContext', () => {
  it('reports a clean tree', () => {
    const s = formatGitContext('main', '')
    expect(s).toContain('branch "main"')
    expect(s).toContain('working tree clean')
    expect(s).not.toContain('Changed files')
  })

  it('summarizes and lists changes', () => {
    const s = formatGitContext('feat/x', ' M src/a.ts\n?? src/b.ts')
    expect(s).toContain('2 uncommitted changes')
    expect(s).toContain('src/a.ts')
    expect(s).toContain('src/b.ts')
  })

  it('singularizes one change', () => {
    expect(formatGitContext('main', ' M only.ts')).toContain('1 uncommitted change.')
  })

  it('truncates long status lists', () => {
    const many = Array.from({ length: 30 }, (_, i) => ` M f${i}.ts`).join('\n')
    const s = formatGitContext('main', many)
    expect(s).toContain('30 uncommitted changes')
    expect(s).toContain('… and 10 more')
  })

  it('returns empty when there is no branch', () => {
    expect(formatGitContext(null, ' M x')).toBe('')
  })
})

describe('gitContext', () => {
  it('returns context for a repo', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'main\n'
      if (args[0] === 'status') return ' M a.ts\n'
      return ''
    }
    const s = await gitContext('/ws', exec)
    expect(s).toContain('branch "main"')
    expect(s).toContain('a.ts')
  })

  it('returns "" when not a git repo', async () => {
    const exec = async (): Promise<string> => {
      throw new Error('not a git repository')
    }
    expect(await gitContext('/ws', exec)).toBe('')
  })

  it('still reports the branch if status fails', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'detached\n'
      throw new Error('status failed')
    }
    const s = await gitContext('/ws', exec)
    expect(s).toContain('branch "detached"')
  })

  it('appends worktree awareness when the repo has linked worktrees', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'feature\n'
      if (args[0] === 'status') return ''
      if (args[0] === 'worktree') {
        return [
          'worktree /repo',
          'HEAD aaa',
          'branch refs/heads/main',
          '',
          'worktree /ws',
          'HEAD bbb',
          'branch refs/heads/feature',
          '',
        ].join('\n')
      }
      return ''
    }
    const s = await gitContext('/ws', exec)
    expect(s).toContain('branch "feature"')
    expect(s).toContain('main worktree is at "/repo"')
    expect(s).toContain('/ws [feature] (current)')
  })

  it('omits worktree awareness for a single-worktree repo', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'main\n'
      if (args[0] === 'status') return ''
      if (args[0] === 'worktree') return 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n'
      return ''
    }
    const s = await gitContext('/repo', exec)
    expect(s).not.toContain('worktree')
    expect(s).not.toContain('Linked')
  })

  it('survives a worktree-list failure (old git)', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'main\n'
      if (args[0] === 'status') return ''
      if (args[0] === 'worktree') throw new Error('unknown subcommand')
      return ''
    }
    const s = await gitContext('/repo', exec)
    expect(s).toContain('branch "main"')
    expect(s).not.toContain('Linked worktrees')
  })
})

describe('parseWorktreePorcelain', () => {
  it('parses main + linked worktrees with branches', () => {
    const out = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-a',
      'HEAD bbb',
      'branch refs/heads/feat/x',
      '',
    ].join('\n')
    const e = parseWorktreePorcelain(out)
    expect(e).toEqual([
      { path: '/repo', branch: 'main', detached: false, bare: false },
      { path: '/repo/wt-a', branch: 'feat/x', detached: false, bare: false },
    ])
  })

  it('flags detached and bare entries', () => {
    const out = [
      'worktree /repo',
      'HEAD aaa',
      'bare',
      '',
      'worktree /repo/wt-d',
      'HEAD bbb',
      'detached',
      '',
    ].join('\n')
    const e = parseWorktreePorcelain(out)
    expect(e[0]).toMatchObject({ path: '/repo', bare: true, branch: null })
    expect(e[1]).toMatchObject({ path: '/repo/wt-d', detached: true, branch: null })
  })

  it('tolerates CRLF, trailing data, and unknown keys', () => {
    const out = 'worktree /repo\r\nHEAD aaa\r\nbranch refs/heads/main\r\nlocked someone\r\n'
    const e = parseWorktreePorcelain(out)
    expect(e).toEqual([{ path: '/repo', branch: 'main', detached: false, bare: false }])
  })

  it('returns [] for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([])
  })
})

describe('formatWorktreeContext', () => {
  const main = { path: '/repo', branch: 'main', detached: false, bare: false }

  it('returns "" for zero or one worktree', () => {
    expect(formatWorktreeContext([], '/repo')).toBe('')
    expect(formatWorktreeContext([main], '/repo')).toBe('')
  })

  it('lists linked worktrees and marks the current one', () => {
    const entries = [
      main,
      { path: '/repo/wt-a', branch: 'feat/x', detached: false, bare: false },
      { path: '/repo/wt-b', branch: null, detached: true, bare: false },
    ]
    const s = formatWorktreeContext(entries, '/repo/wt-a')
    expect(s).toContain('3 worktrees')
    expect(s).toContain('main worktree is at "/repo"')
    expect(s).toContain('/repo/wt-a [feat/x] (current)')
    expect(s).toContain('/repo/wt-b [detached]')
    expect(s).not.toContain('/repo [main]') // main is not repeated in the linked list
  })

  it('marks current even with a trailing slash mismatch', () => {
    const entries = [main, { path: '/repo/wt-a', branch: 'feat/x', detached: false, bare: false }]
    const s = formatWorktreeContext(entries, '/repo/wt-a/')
    expect(s).toContain('(current)')
  })

  it('truncates a long linked list', () => {
    const entries = [
      main,
      ...Array.from({ length: 15 }, (_, i) => ({
        path: `/repo/wt-${i}`,
        branch: `b${i}`,
        detached: false,
        bare: false,
      })),
    ]
    const s = formatWorktreeContext(entries, '/repo')
    expect(s).toContain('16 worktrees')
    expect(s).toContain('… and 5 more')
  })
})

describe('gitDiff', () => {
  it('returns the tracked diff and untracked files', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'true\n'
      if (args[0] === 'diff') return '@@ a.ts @@\n+changed\n'
      if (args[0] === 'ls-files') return 'new.ts\0other.ts\0' // -z: NUL-separated
      return ''
    }
    const d = await gitDiff('/ws', 'HEAD', [], exec)
    expect(d.isRepo).toBe(true)
    expect(d.diff).toContain('+changed')
    expect(d.untracked).toEqual(['new.ts', 'other.ts'])
  })

  it('does not mangle untracked filenames with spaces or non-ASCII (uses -z)', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'true\n'
      if (args[0] === 'diff') return ''
      if (args[0] === 'ls-files') {
        expect(args).toContain('-z') // asked for NUL-separated, unquoted output
        return 'café.txt\0 leading space.txt\0'
      }
      return ''
    }
    const d = await gitDiff('/ws', 'HEAD', [], exec)
    // The leading space and non-ASCII survive (the old newline-split + .trim() lost them).
    expect(d.untracked).toEqual(['café.txt', ' leading space.txt'])
  })

  it('reports not-a-repo when rev-parse fails', async () => {
    const exec = async (): Promise<string> => {
      throw new Error('not a git repository')
    }
    const d = await gitDiff('/ws', 'HEAD', [], exec)
    expect(d).toEqual({ isRepo: false, diff: '', untracked: [] })
  })

  it('still lists untracked files when the diff fails (e.g. unborn HEAD)', async () => {
    const exec = async (args: string[]): Promise<string> => {
      if (args[0] === 'rev-parse') return 'true\n'
      if (args[0] === 'diff') throw new Error('bad revision HEAD')
      if (args[0] === 'ls-files') return 'first.ts\0' // -z: NUL-separated
      return ''
    }
    const d = await gitDiff('/ws', 'HEAD', [], exec)
    expect(d.isRepo).toBe(true)
    expect(d.diff).toBe('')
    expect(d.untracked).toEqual(['first.ts'])
  })

  it('never runs git diff with an option-like base', async () => {
    const seen: string[][] = []
    const exec = async (args: string[]): Promise<string> => {
      seen.push(args)
      if (args[0] === 'rev-parse') return 'true\n'
      return ''
    }
    const d = await gitDiff('/ws', '--output=/tmp/pwn', [], exec)
    expect(d.isRepo).toBe(true)
    expect(seen.some((a) => a[0] === 'diff')).toBe(false) // the dangerous arg never reached git diff
  })

  it('passes a path filter as a pathspec after --', async () => {
    const seen: string[][] = []
    const exec = async (args: string[]): Promise<string> => {
      seen.push(args)
      if (args[0] === 'rev-parse') return 'true\n'
      return ''
    }
    await gitDiff('/ws', 'HEAD', ['src/api', 'README.md'], exec)
    const diffArgs = seen.find((a) => a[0] === 'diff')!
    const lsArgs = seen.find((a) => a[0] === 'ls-files')!
    // The paths come strictly after the `--` separator (can't be read as options).
    expect(diffArgs.slice(diffArgs.indexOf('--'))).toEqual(['--', 'src/api', 'README.md'])
    expect(lsArgs.slice(lsArgs.indexOf('--'))).toEqual(['--', 'src/api', 'README.md'])
  })
})

describe('isSafeGitRef', () => {
  it('accepts ordinary refs and SHAs', () => {
    for (const ref of ['HEAD', 'main', 'origin/main', 'v1.2.3', 'HEAD~3', 'HEAD@{1}', 'a1b2c3d']) {
      expect(isSafeGitRef(ref)).toBe(true)
    }
  })

  it('rejects option-like and shell-ish refs', () => {
    for (const ref of ['--output=/tmp/x', '-O', '', 'a b', '$(id)', 'a;rm -rf', 'a|b']) {
      expect(isSafeGitRef(ref)).toBe(false)
    }
  })
})

describe('git config-driven execution hardening (real repo)', () => {
  // gitContext/gitDiff run automatically and unapproved on workspace open. A repo
  // ships its own .git/config, so core.fsmonitor (run by `git status`) and
  // diff.external/textconv (run by `git diff`) would otherwise execute attacker
  // code in the unsandboxed main process. The default runner must neutralize them.
  const run = (args: string[], cwd: string): void => {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  }

  // Spawns ~12 real `git` subprocesses; give it room under full-suite parallelism
  // / contended CI runners so it can't flake on the default 5s timeout.
  it('does not execute core.fsmonitor / diff.external from a malicious .git/config', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'houston-git-harden-'))
    try {
      run(['init', '-q'], dir)
      run(['config', 'user.email', 't@example.com'], dir)
      run(['config', 'user.name', 'Test'], dir)
      writeFileSync(join(dir, 'a.txt'), 'one\n')
      run(['add', 'a.txt'], dir)
      run(['commit', '-qm', 'init'], dir)
      // A tracked modification so `git diff HEAD` has something to drive a diff driver.
      writeFileSync(join(dir, 'a.txt'), 'two\n')

      // The payload: any git read that honors the config drops this marker.
      const marker = join(dir, 'PWNED')
      const evil = join(dir, 'evil.sh')
      writeFileSync(evil, `#!/bin/sh\ntouch '${marker}'\nexit 0\n`)
      chmodSync(evil, 0o755)
      run(['config', 'core.fsmonitor', evil], dir)
      run(['config', 'diff.external', evil], dir)
      // textconv driver via a gitattribute, another `git diff` execution vector.
      run(['config', 'diff.pwn.textconv', evil], dir)
      writeFileSync(join(dir, '.gitattributes'), 'a.txt diff=pwn\n')

      // The real, hardened default runner (no injected exec).
      await gitContext(dir)
      await gitDiff(dir)

      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
