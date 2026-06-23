import { describe, it, expect } from 'vitest'
import { formatGitContext, gitContext } from './git'

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
})
