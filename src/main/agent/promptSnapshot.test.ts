import { describe, expect, it, vi } from 'vitest'
import { formatPromptSnapshot, localDateStamp, resolvePromptSnapshot } from './promptSnapshot'

describe('localDateStamp', () => {
  it('formats the local calendar date with zero padding', () => {
    expect(localDateStamp(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localDateStamp(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31')
  })
})

describe('resolvePromptSnapshot', () => {
  it('captures a fresh snapshot when none is stored', async () => {
    const capture = vi.fn(async () => 'Git: on branch "main", working tree clean.')
    const r = await resolvePromptSnapshot(undefined, '2026-10-15', capture)
    expect(r).toEqual({
      snapshot: { date: '2026-10-15', gitStatus: 'Git: on branch "main", working tree clean.' },
      fresh: true
    })
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('reuses the stored snapshot on the same day without touching git', async () => {
    const stored = { date: '2026-10-15', gitStatus: 'OLD STATUS' }
    const capture = vi.fn(async () => 'NEW STATUS')
    const r = await resolvePromptSnapshot(stored, '2026-10-15', capture)
    expect(r).toEqual({ snapshot: stored, fresh: false })
    expect(capture).not.toHaveBeenCalled()
  })

  it('retakes the snapshot once the local date has moved on', async () => {
    const stored = { date: '2026-10-14', gitStatus: 'OLD STATUS' }
    const r = await resolvePromptSnapshot(stored, '2026-10-15', async () => 'NEW STATUS')
    expect(r).toEqual({ snapshot: { date: '2026-10-15', gitStatus: 'NEW STATUS' }, fresh: true })
  })
})

describe('formatPromptSnapshot', () => {
  it('always states the date, and labels git context as a snapshot', () => {
    const out = formatPromptSnapshot({ date: '2026-10-15', gitStatus: 'Git: on branch "main".\n' })
    expect(out).toBe(
      "Today's date: 2026-10-15.\n\nGit snapshot (taken earlier in this conversation and not updated as files change; run git status for the current state):\nGit: on branch \"main\"."
    )
  })

  it('omits the git section outside a repo', () => {
    expect(formatPromptSnapshot({ date: '2026-10-15', gitStatus: '  ' })).toBe("Today's date: 2026-10-15.")
  })
})
