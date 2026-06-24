import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/agent'
import { applyCompaction } from './compact'
import { COMPACTION_SUMMARY_PREFIX } from './compaction'

const msgs: ChatMessage[] = [
  { role: 'user', content: 'first' },
  { role: 'assistant', content: 'reply' },
  { role: 'user', content: 'recent' },
  { role: 'assistant', content: 'recent reply' }
]

describe('applyCompaction', () => {
  it('replaces the head with a summary pair and keeps the tail', () => {
    const out = applyCompaction(msgs, 2, 'dense summary')
    expect(out).toHaveLength(4) // 2 summary messages + 2 kept
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain(COMPACTION_SUMMARY_PREFIX)
    expect(out[0].content).toContain('dense summary')
    expect(out[1].role).toBe('assistant')
    expect(out.slice(2)).toEqual(msgs.slice(2))
  })

  it('keeps everything when cut is 0 (just the summary pair prepended)', () => {
    const out = applyCompaction(msgs, 0, 'S')
    expect(out.slice(2)).toEqual(msgs)
  })
})
