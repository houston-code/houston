import { describe, expect, it, vi } from 'vitest'
import type { ConversationWorktree, WorktreeRemoval } from '@shared/agent'
import { removeWorktreeOnArchive, type ArchiveWorktreeDeps } from './archiveWorktree'

const wt: ConversationWorktree = { path: '/repo/.houston/worktrees/x', branch: 'feat/x', repoRoot: '/repo' }

function deps(over: Partial<ArchiveWorktreeDeps> = {}): ArchiveWorktreeDeps & {
  remove: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
} {
  const removed: WorktreeRemoval = { removed: true, branchDeleted: true }
  return {
    peek: () => ({ worktree: wt, archived: true }),
    sharedCount: () => 0,
    busy: () => false,
    isDisposable: async () => true,
    remove: vi.fn(async () => removed),
    detach: vi.fn(),
    ...over
  } as never
}

describe('removeWorktreeOnArchive', () => {
  it('removes a clean, merged worktree and moves the chat to the repo root', async () => {
    const d = deps()
    const res = await removeWorktreeOnArchive('c1', d)
    expect(res).toEqual({ removed: true, branchDeleted: true })
    expect(d.remove).toHaveBeenCalledWith(wt)
    expect(d.detach).toHaveBeenCalledWith('c1', '/repo')
  })

  it('leaves a worktree with changes or unmerged commits', async () => {
    const d = deps({ isDisposable: async () => false })
    expect(await removeWorktreeOnArchive('c1', d)).toBeNull()
    expect(d.remove).not.toHaveBeenCalled()
    expect(d.detach).not.toHaveBeenCalled()
  })

  it('leaves a worktree another chat still uses', async () => {
    const d = deps({ sharedCount: () => 1 })
    expect(await removeWorktreeOnArchive('c1', d)).toBeNull()
    expect(d.remove).not.toHaveBeenCalled()
  })

  it('leaves the worktree while the chat has a live run or running shells', async () => {
    const d = deps({ busy: () => true })
    expect(await removeWorktreeOnArchive('c1', d)).toBeNull()
    expect(d.remove).not.toHaveBeenCalled()
  })

  it('does nothing for a chat without a worktree, or one not archived', async () => {
    const a = deps({ peek: () => ({ archived: true }) })
    expect(await removeWorktreeOnArchive('c1', a)).toBeNull()
    const b = deps({ peek: () => ({ worktree: wt }) })
    expect(await removeWorktreeOnArchive('c1', b)).toBeNull()
    const c = deps({ peek: () => undefined })
    expect(await removeWorktreeOnArchive('c1', c)).toBeNull()
    expect(a.remove).not.toHaveBeenCalled()
    expect(b.remove).not.toHaveBeenCalled()
    expect(c.remove).not.toHaveBeenCalled()
  })

  it('does not remove it when the chat was unarchived during the check', async () => {
    let archived = true
    const d = deps({
      peek: () => ({ worktree: wt, ...(archived ? { archived: true } : {}) }),
      isDisposable: async () => {
        archived = false
        return true
      }
    })
    expect(await removeWorktreeOnArchive('c1', d)).toBeNull()
    expect(d.remove).not.toHaveBeenCalled()
  })

  it('keeps the chat pointed at its worktree when removal fails', async () => {
    const d = deps({ remove: vi.fn(async () => ({ removed: false, branchDeleted: false, message: 'no' })) as never })
    const res = await removeWorktreeOnArchive('c1', d)
    expect(res?.removed).toBe(false)
    expect(d.detach).not.toHaveBeenCalled()
  })

  it('never throws', async () => {
    const d = deps({
      isDisposable: async () => {
        throw new Error('boom')
      }
    })
    expect(await removeWorktreeOnArchive('c1', d)).toBeNull()
  })
})
