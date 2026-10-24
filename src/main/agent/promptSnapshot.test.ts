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

  it('retakes a malformed stored snapshot instead of trusting it', async () => {
    // The conversation file's load-time shape check doesn't cover this field, so a
    // hand-edited or corrupt value must not reach formatPromptSnapshot (which would
    // throw on a non-string gitStatus and fail every run of the chat).
    for (const stored of [
      { date: '2026-10-15', gitStatus: 42 },
      { date: '2026-10-15' },
      { gitStatus: 'x' },
      'garbage',
      null
    ]) {
      const r = await resolvePromptSnapshot(stored as never, '2026-10-15', async () => 'FRESH')
      expect(r, JSON.stringify(stored)).toEqual({
        snapshot: { date: '2026-10-15', gitStatus: 'FRESH' },
        fresh: true
      })
    }
  })
})

describe('resolvePromptSnapshot memory index', () => {
  it('captures the memory index with a fresh snapshot', async () => {
    const r = await resolvePromptSnapshot(undefined, '2026-10-15', async () => 'G', () => 'Memory: ...')
    expect(r.snapshot).toEqual({ date: '2026-10-15', gitStatus: 'G', memory: 'Memory: ...' })
  })

  it('stores no memory key when the index is empty or memory is off', async () => {
    expect((await resolvePromptSnapshot(undefined, '2026-10-15', async () => 'G', () => '')).snapshot).toEqual({
      date: '2026-10-15',
      gitStatus: 'G'
    })
    expect((await resolvePromptSnapshot(undefined, '2026-10-15', async () => 'G')).snapshot).toEqual({
      date: '2026-10-15',
      gitStatus: 'G'
    })
  })

  it('reuses a same-day snapshot without re-reading memories, even one that predates memory', async () => {
    const capture = vi.fn(() => 'NEW INDEX')
    const stored = { date: '2026-10-15', gitStatus: 'G' }
    expect(await resolvePromptSnapshot(stored, '2026-10-15', async () => 'X', capture)).toEqual({
      snapshot: stored,
      fresh: false
    })
    expect(capture).not.toHaveBeenCalled()
  })

  it('retakes a snapshot whose memory field is malformed', async () => {
    const stored = { date: '2026-10-15', gitStatus: 'G', memory: 7 }
    const r = await resolvePromptSnapshot(stored as never, '2026-10-15', async () => 'G2', () => 'M')
    expect(r).toEqual({ snapshot: { date: '2026-10-15', gitStatus: 'G2', memory: 'M' }, fresh: true })
  })
})

describe('formatPromptSnapshot', () => {
  it('puts the memory index first, and leaves it out when memory is off', () => {
    const snap = { date: '2026-10-15', gitStatus: '', memory: 'Memory: notes\n- m_1' }
    expect(formatPromptSnapshot(snap)).toBe("Memory: notes\n- m_1\n\nToday's date: 2026-10-15.")
    expect(formatPromptSnapshot(snap, { memory: false })).toBe("Today's date: 2026-10-15.")
  })

  it('always states the date, and labels git context as a snapshot', () => {
    const out = formatPromptSnapshot({ date: '2026-10-15', gitStatus: 'Git: on branch "main".\n' })
    expect(out).toBe(
      "Today's date: 2026-10-15.\n\nGit snapshot (taken earlier in this conversation and not updated as files change; use git_status for the current state):\nGit: on branch \"main\"."
    )
  })

  it('names only tools the run offers', () => {
    const snap = { date: '2026-10-15', gitStatus: 'Git: on branch "main".', memory: 'Memory: notes\n- m_1' }
    const shellOnly = formatPromptSnapshot(snap, { tools: ['read_file', 'run_shell'] })
    expect(shellOnly).not.toContain('Memory: notes') // the index points at recall_memory
    expect(shellOnly).toContain('not updated as files change; run `git status` for the current state):')
    const readOnly = formatPromptSnapshot(snap, { tools: ['read_file'] })
    expect(readOnly).toContain('(taken earlier in this conversation and not updated as files change):')
    expect(formatPromptSnapshot(snap, { tools: ['recall_memory', 'git_status'] })).toBe(formatPromptSnapshot(snap))
  })

  it('omits the git section outside a repo', () => {
    expect(formatPromptSnapshot({ date: '2026-10-15', gitStatus: '  ' })).toBe("Today's date: 2026-10-15.")
  })
})
