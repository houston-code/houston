import { describe, it, expect, vi } from 'vitest'

vi.mock('./agent/loop', () => ({ activeRunForConversation: () => null, cancelRun: () => {} }))

import { deleteChat, planChatDelete, resolveDeleteAction, type DeleteChatDeps } from './deleteChat'
import type { ConversationWorktree } from '@shared/agent'

const wt: ConversationWorktree = { path: '/repo/.houston/worktrees/feat', branch: 'houston/feat', repoRoot: '/repo' }

function fake(
  over: Partial<DeleteChatDeps> & { conv?: { title?: string; worktree?: ConversationWorktree } | null } = {}
) {
  const calls = { deleted: [] as string[], removed: [] as ConversationWorktree[], order: [] as string[] }
  const { conv, ...rest } = over
  const deps: DeleteChatDeps = {
    peek: () => (conv === undefined ? { title: 'Feat', worktree: wt } : conv),
    sharedCount: () => 0,
    isDisposable: async () => false,
    removeWorktree: async (w) => {
      calls.removed.push(w)
      calls.order.push('remove')
      return { removed: true, branchDeleted: true }
    },
    stopAndWait: async () => {
      // Shells take a moment to end after they are signalled.
      await new Promise((r) => setTimeout(r, 5))
      calls.order.push('stopped')
    },
    stopAndDelete: (id) => {
      calls.deleted.push(id)
      calls.order.push('deleted')
    },
    ...rest
  }
  return { deps, calls }
}

describe('planChatDelete', () => {
  it('a chat without a worktree is a plain delete', async () => {
    const { deps } = fake({ conv: { title: 'Hi' } })
    expect(await planChatDelete('c', deps)).toEqual({ kind: 'plain', title: 'Hi', shared: false })
  })

  it('a worktree holding work gets the keep/remove choice', async () => {
    const { deps } = fake()
    expect(await planChatDelete('c', deps)).toMatchObject({ kind: 'worktree', worktree: wt, shared: false })
  })

  it('a clean, merged worktree goes with the chat', async () => {
    const { deps } = fake({ isDisposable: async () => true })
    expect((await planChatDelete('c', deps)).kind).toBe('disposableWorktree')
  })

  it('a worktree another chat uses is plain and shared, even when disposable', async () => {
    const { deps } = fake({ sharedCount: () => 1, isDisposable: async () => true })
    expect(await planChatDelete('c', deps)).toMatchObject({ kind: 'plain', shared: true, worktree: wt })
  })

  it('a failed disposability check keeps the choice', async () => {
    const { deps } = fake({ isDisposable: () => Promise.reject(new Error('git')) })
    expect((await planChatDelete('c', deps)).kind).toBe('worktree')
  })
})

describe('deleteChat', () => {
  it('keep: deletes the chat and leaves the worktree', async () => {
    const { deps, calls } = fake()
    const plan = await planChatDelete('c', deps)
    expect(await deleteChat('c', plan, false, deps)).toEqual({ deleted: true, worktree: null })
    expect(calls.deleted).toEqual(['c'])
    expect(calls.removed).toEqual([])
  })

  it('remove: deletes the chat and tears the worktree down', async () => {
    const { deps, calls } = fake()
    const plan = await planChatDelete('c', deps)
    const res = await deleteChat('c', plan, true, deps)
    expect(res.worktree).toEqual({ removed: true, branchDeleted: true })
    expect(calls.removed).toEqual([wt])
  })

  it("waits for the chat's shells to end before removing the worktree", async () => {
    const { deps, calls } = fake()
    const plan = await planChatDelete('c', deps)
    await deleteChat('c', plan, true, deps)
    expect(calls.order).toEqual(['stopped', 'deleted', 'remove'])
  })

  it('does not wait for shells when the worktree stays', async () => {
    const { deps, calls } = fake()
    const plan = await planChatDelete('c', deps)
    await deleteChat('c', plan, false, deps)
    expect(calls.order).toEqual(['deleted'])
  })

  it('never removes a shared worktree, even when asked', async () => {
    const { deps, calls } = fake({ sharedCount: () => 2 })
    const plan = await planChatDelete('c', deps)
    await deleteChat('c', plan, true, deps)
    expect(calls.deleted).toEqual(['c'])
    expect(calls.removed).toEqual([])
  })
})

describe('resolveDeleteAction', () => {
  it('button 0 always cancels', () => {
    for (const kind of ['plain', 'worktree', 'disposableWorktree'] as const) {
      expect(resolveDeleteAction(kind, 0)).toEqual({ delete: false, removeWorktree: false })
    }
  })
})
