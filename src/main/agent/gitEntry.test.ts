import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { findGitEntry, gitErrorLine } from './gitEntry'

describe('findGitEntry', () => {
  const root = join('/', 'a')
  it('finds a .git in the folder itself or the nearest parent', () => {
    const at = new Set([join(root, '.git'), join(root, 'b', 'c', '.git')])
    const exists = (p: string): boolean => at.has(p)
    expect(findGitEntry(join(root, 'b', 'c'), exists)).toBe(join(root, 'b', 'c', '.git'))
    expect(findGitEntry(join(root, 'b', 'd', 'e'), exists)).toBe(join(root, '.git'))
  })

  it('returns null when no folder up to the root has one', () => {
    expect(findGitEntry(join(root, 'b'), () => false)).toBeNull()
  })
})

describe('gitErrorLine', () => {
  it('keeps the first line and drops the fatal prefix', () => {
    expect(gitErrorLine('fatal: not a git repository: (null)\nmore\n')).toBe('not a git repository: (null)')
    expect(gitErrorLine('\n  error: bad config\n')).toBe('bad config')
  })

  it('caps a long line and falls back when git printed nothing', () => {
    const line = gitErrorLine(`fatal: ${'x'.repeat(1000)}`)
    expect(line.length).toBe(300)
    expect(line.endsWith('…')).toBe(true)
    expect(gitErrorLine('')).toBe('git could not open it.')
  })
})
