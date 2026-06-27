import { describe, expect, it } from 'vitest'
import { resolveDeleteAction } from './ipc'

/**
 * The delete-confirmation dialog used to be a two-button `window.confirm` whose
 * "Cancel" still deleted the chat (it only governed the worktree). These guard
 * the replacement: button 0 is always Cancel, so a cancel never deletes, and only
 * the worktree dialog's button 2 tears the worktree down.
 */
describe('resolveDeleteAction', () => {
  it('treats button 0 as Cancel — never deletes — for a plain chat', () => {
    expect(resolveDeleteAction(false, 0)).toEqual({ delete: false, removeWorktree: false })
  })

  it('treats button 0 as Cancel — never deletes — for a worktree chat', () => {
    expect(resolveDeleteAction(true, 0)).toEqual({ delete: false, removeWorktree: false })
  })

  it('deletes a plain chat on button 1, leaving no worktree to remove', () => {
    expect(resolveDeleteAction(false, 1)).toEqual({ delete: true, removeWorktree: false })
  })

  it('deletes a worktree chat but keeps the worktree on button 1', () => {
    expect(resolveDeleteAction(true, 1)).toEqual({ delete: true, removeWorktree: false })
  })

  it('deletes and removes the worktree on button 2', () => {
    expect(resolveDeleteAction(true, 2)).toEqual({ delete: true, removeWorktree: true })
  })

  it('never removes a worktree that does not exist, even on button 2', () => {
    expect(resolveDeleteAction(false, 2)).toEqual({ delete: true, removeWorktree: false })
  })
})
