import { describe, it, expect } from 'vitest'
import { suggestBranch, branchNameError } from './worktree'

describe('suggestBranch', () => {
  it('produces an <adjective>-<noun>-<suffix> branch name (no path prefix)', () => {
    expect(suggestBranch()).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{6}$/)
  })

  it('varies the random suffix between calls', () => {
    const suffix = (b: string): string => b.split('-')[2]
    const suffixes = new Set(Array.from({ length: 20 }, () => suffix(suggestBranch())))
    // 20 draws from 36^6 should never all collide.
    expect(suffixes.size).toBeGreaterThan(1)
  })
})

describe('branchNameError', () => {
  it('rejects an empty name', () => {
    expect(branchNameError('   ', [])).toMatch(/Enter a branch name/)
  })

  it('rejects an option-like (leading dash) name', () => {
    expect(branchNameError('--evil', [])).toMatch(/letters, numbers/)
  })

  it('rejects a name that already exists as a branch', () => {
    expect(branchNameError('feature/x', ['main', 'feature/x'])).toMatch(/already exists/)
  })

  it('accepts a fresh, valid branch name', () => {
    expect(branchNameError('houston/swift-otter', ['main'])).toBeNull()
  })

  it('trims surrounding whitespace before validating', () => {
    expect(branchNameError('  feat/ok  ', ['main'])).toBeNull()
  })
})
