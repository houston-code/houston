import { describe, it, expect } from 'vitest'
import { deletePromptText, deleteWorktreeOutcome, parseDeleteAnswer } from './tui-delete'
import type { DeletePlan } from './deleteChat'

const wt = { path: '/r/wt', branch: 'houston/x', repoRoot: '/r' }
const keepable: DeletePlan = { kind: 'worktree', worktree: wt, shared: false }
const disposable: DeletePlan = { kind: 'disposableWorktree', worktree: wt, shared: false }
const shared: DeletePlan = { kind: 'plain', worktree: wt, shared: true }
const plain: DeletePlan = { kind: 'plain', shared: false }

describe('deletePromptText', () => {
  it('words each case like the desktop dialog', () => {
    expect(deletePromptText(plain, 'T', '2 messages')).toBe('Delete "T" and its 2 messages? This cannot be undone. [y/N] ')
    expect(deletePromptText(keepable, 'T', '1 message')).toContain('branch "houston/x"')
    expect(deletePromptText(keepable, 'T', '1 message')).toMatch(/\[k\/r\/N\] $/)
    expect(deletePromptText(disposable, 'T', '1 message')).toContain('so it will be removed too')
    expect(deletePromptText(shared, 'T', '1 message')).toContain('another chat still uses it')
  })
})

describe('parseDeleteAnswer', () => {
  it('a worktree chat needs k or r; anything else keeps everything', () => {
    expect(parseDeleteAnswer(keepable, 'k')).toEqual({ delete: true, removeWorktree: false })
    expect(parseDeleteAnswer(keepable, ' Remove ')).toEqual({ delete: true, removeWorktree: true })
    for (const a of ['', 'y', 'yes', 'n', 'x', null, undefined]) {
      expect(parseDeleteAnswer(keepable, a)).toEqual({ delete: false, removeWorktree: false })
    }
  })

  it('other chats need a yes; a disposable worktree goes with it', () => {
    expect(parseDeleteAnswer(plain, 'y')).toEqual({ delete: true, removeWorktree: false })
    expect(parseDeleteAnswer(shared, 'YES')).toEqual({ delete: true, removeWorktree: false })
    expect(parseDeleteAnswer(disposable, 'y')).toEqual({ delete: true, removeWorktree: true })
    expect(parseDeleteAnswer(disposable, '')).toEqual({ delete: false, removeWorktree: false })
    expect(parseDeleteAnswer(plain, 'r')).toEqual({ delete: false, removeWorktree: false })
  })
})

describe('deleteWorktreeOutcome', () => {
  it('says what became of the worktree', () => {
    expect(deleteWorktreeOutcome(plain, { deleted: true })).toBe('')
    expect(deleteWorktreeOutcome(keepable, { deleted: true, worktree: null })).toContain('kept its worktree at /r/wt')
    expect(deleteWorktreeOutcome(shared, { deleted: true })).toContain('another chat still uses it')
    expect(deleteWorktreeOutcome(keepable, { deleted: true, worktree: { removed: true, branchDeleted: true } })).toBe(
      'removed its worktree and branch "houston/x"'
    )
    expect(
      deleteWorktreeOutcome(keepable, {
        deleted: true,
        worktree: { removed: false, branchDeleted: false, message: 'dirty' }
      })
    ).toBe('dirty')
  })
})
