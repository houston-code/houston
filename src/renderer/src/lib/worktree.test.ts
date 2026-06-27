import { describe, it, expect } from 'vitest'
import { suggestBranch, branchNameError } from './worktree'

describe('suggestBranch', () => {
  it('produces a houston/<adjective>-<noun> branch name', () => {
    expect(suggestBranch()).toMatch(/^houston\/[a-z]+-[a-z]+$/)
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
