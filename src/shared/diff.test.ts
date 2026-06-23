import { describe, expect, it } from 'vitest'
import { diffLines, diffStat } from './diff'

describe('diffLines', () => {
  it('marks identical content as context', () => {
    const d = diffLines('a\nb\nc', 'a\nb\nc')
    expect(d.every((l) => l.type === 'ctx')).toBe(true)
    expect(d.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('detects a single changed line as a delete + add around context', () => {
    const d = diffLines('a\nb\nc', 'a\nB\nc')
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' }
    ])
  })

  it('treats empty old as all additions (new file)', () => {
    const d = diffLines('', 'x\ny')
    expect(d).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' }
    ])
  })

  it('treats empty new as all deletions', () => {
    const d = diffLines('x\ny', '')
    expect(d).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' }
    ])
  })

  it('handles pure insertion in the middle', () => {
    const d = diffLines('a\nc', 'a\nb\nc')
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'ctx', text: 'c' }
    ])
  })

  it('handles a pure deletion', () => {
    const d = diffLines('a\nb\nc', 'a\nc')
    expect(d).toEqual([
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'ctx', text: 'c' }
    ])
  })

  it('preserves a kept line exactly once when reconstructing both sides', () => {
    const d = diffLines('a\nb', 'b\nc')
    // old reconstruction = del+ctx, new reconstruction = ctx+add
    expect(d.filter((l) => l.type !== 'add').map((l) => l.text)).toEqual(['a', 'b'])
    expect(d.filter((l) => l.type !== 'del').map((l) => l.text)).toEqual(['b', 'c'])
  })

  it('falls back to a coarse diff for very large inputs without hanging', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n')
    const d = diffLines(big, `${big}\nextra`)
    // Coarse path: every old line deleted, every new line added.
    expect(d.filter((l) => l.type === 'del')).toHaveLength(2500)
    expect(d.filter((l) => l.type === 'add')).toHaveLength(2501)
  })
})

describe('diffStat', () => {
  it('counts additions and removals', () => {
    expect(diffStat(diffLines('a\nb\nc', 'a\nB\nc'))).toEqual({ added: 1, removed: 1 })
    expect(diffStat(diffLines('', 'x\ny\nz'))).toEqual({ added: 3, removed: 0 })
  })
})
