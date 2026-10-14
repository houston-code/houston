import { describe, it, expect } from 'vitest'
import type { RepoInfo } from '@shared/agent'
import {
  suggestBranch,
  branchNameError,
  canCreateWorktree,
  defaultBaseBranch,
  planNewChatWorkspace
} from './worktree'

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

describe('planNewChatWorkspace', () => {
  const repo = (over: Partial<RepoInfo> = {}): RepoInfo => ({
    isRepo: true,
    root: '/repo',
    currentBranch: 'main',
    unborn: false,
    branches: ['main'],
    isLinkedWorktreeRoot: false,
    exists: true,
    ...over
  })

  it('keeps a picked subdirectory of the repo, with the worktree toggle off', () => {
    expect(planNewChatWorkspace(repo(), '/repo/packages/foo')).toEqual({
      action: 'keep',
      worktreeDefault: false
    })
  })

  it('re-anchors a linked-worktree root to the repo main root', () => {
    expect(
      planNewChatWorkspace(repo({ isLinkedWorktreeRoot: true }), '/repo/.houston/worktrees/x')
    ).toEqual({ action: 'reanchor', root: '/repo' })
  })

  it('keeps a non-repo folder untouched, with the worktree toggle off', () => {
    const info = repo({ isRepo: false, root: '', currentBranch: null, branches: [] })
    expect(planNewChatWorkspace(info, '/some/folder')).toEqual({
      action: 'keep',
      worktreeDefault: false
    })
  })

  it('keeps the repo main root, with the worktree toggle on', () => {
    expect(planNewChatWorkspace(repo(), '/repo')).toEqual({
      action: 'keep',
      worktreeDefault: true
    })
  })

  it('ignores a trailing slash when matching the repo root', () => {
    expect(planNewChatWorkspace(repo(), '/repo/')).toEqual({
      action: 'keep',
      worktreeDefault: true
    })
  })

  it('drops a workspace that no longer exists on disk', () => {
    expect(planNewChatWorkspace(repo({ exists: false }), '/repo')).toEqual({ action: 'drop' })
  })
})

describe('unborn repos (no commits on the current branch)', () => {
  const info = (over: Partial<RepoInfo> = {}): RepoInfo => ({
    isRepo: true,
    root: '/repo',
    currentBranch: 'main',
    unborn: true,
    branches: [],
    isLinkedWorktreeRoot: false,
    exists: true,
    ...over
  })

  it('defaults the worktree toggle off at the repo root', () => {
    expect(planNewChatWorkspace(info(), '/repo')).toEqual({ action: 'keep', worktreeDefault: false })
  })

  it('cannot create a worktree with no commit anywhere, but can from another branch', () => {
    expect(canCreateWorktree(info())).toBe(false)
    expect(canCreateWorktree(info({ branches: ['lucid'] }))).toBe(true)
    expect(canCreateWorktree(info({ unborn: false, branches: ['main'] }))).toBe(true)
    expect(canCreateWorktree(info({ isRepo: false, unborn: false }))).toBe(false)
  })

  it('starts the base picker on a branch the picker lists', () => {
    // Unborn current branch: newest branch with commits, never the unborn one.
    expect(defaultBaseBranch(info({ branches: ['lucid', 'older'] }))).toBe('lucid')
    expect(defaultBaseBranch(info())).toBe('')
    // Born branch: itself. Detached HEAD: '' (the "HEAD (detached)" option).
    expect(defaultBaseBranch(info({ unborn: false, branches: ['main'] }))).toBe('main')
    expect(defaultBaseBranch(info({ unborn: false, currentBranch: null }))).toBe('')
  })
})
