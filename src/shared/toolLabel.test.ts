import { describe, expect, it } from 'vitest'
import { describeToolCall } from './toolLabel'

describe('describeToolCall', () => {
  it('keeps paths whole unless a shortener is given', () => {
    expect(describeToolCall('write_file', { path: 'a/b/c/d.ts' })).toEqual({ verb: 'Write', target: 'a/b/c/d.ts', mono: true })
    const short = describeToolCall('write_file', { path: 'a/b/c/d.ts' }, { shorten: (p) => `…/${p.split('/').pop()}` })
    expect(short.target).toBe('…/d.ts')
  })

  it('falls back to the wire name and summary for an unknown tool', () => {
    expect(describeToolCall('mystery', { path: 'x' }, { summary: 'doing it' })).toEqual({
      verb: 'mystery',
      target: 'doing it',
      mono: true
    })
  })
})
