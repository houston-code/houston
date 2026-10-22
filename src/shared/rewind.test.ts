import { describe, expect, it } from 'vitest'
import { COMPACTION_SUMMARY_PREFIX, SYSTEM_NOTE_PREFIX, type ChatMessage } from './agent'
import {
  compactionAfterTruncate,
  isRewindMode,
  rewindConfirmText,
  rewindDoneText,
  rewindPoints,
  rewindableTurnIndices,
  turnLabel,
  turnText
} from './rewind'

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: 'user', content, ...extra })
const asst = (content: string): ChatMessage => ({ role: 'assistant', content })

describe('rewind points', () => {
  it('numbers only the messages the user sent', () => {
    const log: ChatMessage[] = [
      user(`${COMPACTION_SUMMARY_PREFIX} earlier`),
      asst('ok'),
      user('first'),
      asst('a'),
      user(`${SYSTEM_NOTE_PREFIX} nudge`),
      user('steer', { steered: true }),
      user('   '),
      user('', { images: [{ mediaType: 'image/png', data: 'AA==' }] }),
      { role: 'tool', content: 'x', toolCallId: 'c' },
      user('second')
    ]
    expect(rewindableTurnIndices(log)).toEqual([2, 7, 9])
    expect(rewindPoints(log).map((p) => p.label)).toEqual(['first', '(image)', 'second'])
  })

  it('names an invoked turn by what the user typed, not the expanded prompt', () => {
    const m = user('long review instructions…', {
      invokedAs: { kind: 'command', label: '/review', typed: '/review src' }
    })
    expect(turnText(m)).toBe('/review src')
    expect(turnLabel(m)).toBe('/review src')
    expect(turnText(user('x', { invokedAs: { kind: 'action', label: 'Create PR' } }))).toBe('Create PR')
  })

  it('flattens and truncates a long label', () => {
    expect(turnLabel(user('a\n\nb   c'))).toBe('a b c')
    const label = turnLabel(user('x'.repeat(200)), 10)
    expect(label).toHaveLength(10)
    expect(label.endsWith('…')).toBe(true)
  })

  it('validates modes', () => {
    expect(['both', 'conversation', 'code'].every(isRewindMode)).toBe(true)
    expect(isRewindMode('all')).toBe(false)
    expect(isRewindMode(undefined)).toBe(false)
  })
})

describe('compactionAfterTruncate', () => {
  it('keeps a summary of messages that all survive', () => {
    expect(compactionAfterTruncate({ cut: 4, summary: 'S' }, 6)).toEqual({ cut: 4, summary: 'S' })
    // Cut exactly at the target: the summary covers everything kept.
    expect(compactionAfterTruncate({ cut: 6, summary: 'S' }, 6)).toEqual({ cut: 6, summary: 'S' })
  })

  it('drops a summary that covered removed messages', () => {
    expect(compactionAfterTruncate({ cut: 8, summary: 'S' }, 6)).toBeNull()
  })

  it('an anchored cut needs its assistant message kept', () => {
    expect(compactionAfterTruncate({ cut: 5, summary: 'S', anchor: 3 }, 6)).toEqual({
      cut: 5,
      summary: 'S',
      anchor: 3
    })
    expect(compactionAfterTruncate({ cut: 6, summary: 'S', anchor: 3 }, 6)).toBeNull()
  })

  it('clamps the eviction watermark and keeps it alone when the summary goes', () => {
    expect(compactionAfterTruncate({ cut: 4, summary: 'S', evictBefore: 9 }, 6)).toEqual({
      cut: 4,
      summary: 'S',
      evictBefore: 6
    })
    expect(compactionAfterTruncate({ cut: 8, summary: 'S', evictBefore: 9 }, 6)).toEqual({
      cut: 0,
      summary: '',
      evictBefore: 6
    })
    expect(compactionAfterTruncate({ cut: 0, summary: '', evictBefore: 3 }, 0)).toBeNull()
  })

  it('nothing in, nothing out', () => {
    expect(compactionAfterTruncate(undefined, 3)).toBeNull()
  })
})

describe('rewind copy', () => {
  const preview = { turns: 2, files: 3, conflicts: [], unavailable: 0 }

  it('says what each mode changes, and that shell side effects stay', () => {
    const both = rewindConfirmText('both', preview)
    expect(both).toContain('Removes 2 messages you sent')
    expect(both).toContain('Restores 3 files')
    expect(both).toContain("Changes made by shell commands aren't tracked")
    const conv = rewindConfirmText('conversation', preview)
    expect(conv).not.toContain('Restores')
    expect(conv).not.toContain('shell')
    expect(rewindConfirmText('code', preview)).not.toContain('Removes')
  })

  it('names files it will leave alone and turns it cannot restore', () => {
    const text = rewindConfirmText('code', { turns: 1, files: 1, conflicts: ['a.ts'], unavailable: 2 })
    expect(text).toContain('1 file changed since the agent wrote it and will be left as it is: a.ts.')
    expect(text).toContain("2 earlier turns can't be restored")
  })

  it('never uses an em dash', () => {
    const texts = [
      rewindConfirmText('both', { turns: 1, files: 0, conflicts: Array(7).fill('x'), unavailable: 1 }),
      rewindDoneText('both', {
        messages: [],
        text: '',
        restored: 1,
        conflicts: ['a'],
        unavailable: 1,
        undoable: true
      })
    ]
    for (const t of texts) expect(t).not.toContain('—')
  })
})
