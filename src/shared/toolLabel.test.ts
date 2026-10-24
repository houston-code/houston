import { describe, expect, it } from 'vitest'
import { describeToolCall } from './toolLabel'

describe('describeToolCall', () => {
  it('keeps paths whole unless a shortener is given', () => {
    expect(describeToolCall('write_file', { path: 'a/b/c/d.ts' })).toEqual({ verb: 'Write', target: 'a/b/c/d.ts', mono: true })
    const short = describeToolCall('write_file', { path: 'a/b/c/d.ts' }, { shorten: (p) => `…/${p.split('/').pop()}` })
    expect(short.target).toBe('…/d.ts')
  })

  it('names memory calls in plain words', () => {
    expect(describeToolCall('memory_save', { name: 'tests-need-rg' })).toEqual({ verb: 'Remember', target: 'tests-need-rg', mono: false })
    expect(describeToolCall('memory_save', { id: 'm_1', name: 'x' }).verb).toBe('Update memory')
    expect(describeToolCall('memory_delete', { id: 'm_1' })).toEqual({ verb: 'Forget memory', target: 'm_1', mono: false })
    expect(describeToolCall('recall_memory', { query: 'rg' }).target).toBe('rg')
    expect(describeToolCall('recall_memory', { id: 'm_1' }).target).toBe('m_1')
  })

  it('falls back to the wire name and summary for an unknown tool', () => {
    expect(describeToolCall('mystery', { path: 'x' }, { summary: 'doing it' })).toEqual({
      verb: 'mystery',
      target: 'doing it',
      mono: true
    })
  })
})
