import { describe, expect, it } from 'vitest'
import { diffLines, diffStat, hunkDiff } from './diff'

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

describe('hunkDiff', () => {
  const longFile = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n')

  // The bug this exists for: a preview was the WHOLE file's diff, cut with
  // slice(0, N). For an edit late in a long file that budget was spent entirely on
  // untouched context, so the approval card showed a diff containing no changes.
  it('keeps a change that is far past any line budget', () => {
    const before = longFile(600)
    const after = before.replace('line 500', 'line 500 CHANGED')
    const full = diffLines(before, after)
    expect(full.slice(0, 400).filter((l) => l.type !== 'ctx')).toHaveLength(0) // the old behavior

    const hunked = hunkDiff(full)
    const changes = hunked.filter((l) => l.type === 'add' || l.type === 'del')
    expect(changes).toHaveLength(2)
    expect(changes.some((l) => l.text.includes('CHANGED'))).toBe(true)
    expect(hunked.length).toBeLessThan(20) // and it is small enough to read
  })

  it('keeps context either side of a change', () => {
    const hunked = hunkDiff(diffLines(longFile(20), longFile(20).replace('line 10', 'line 10 X')))
    const ctx = hunked.filter((l) => l.type === 'ctx')
    expect(ctx.some((l) => l.text === 'line 7')).toBe(true) // 3 before
    expect(ctx.some((l) => l.text === 'line 13')).toBe(true) // 3 after
    expect(ctx.some((l) => l.text === 'line 2')).toBe(false) // far away: folded
  })

  it('replaces each folded run with a counted marker', () => {
    const hunked = hunkDiff(diffLines(longFile(30), longFile(30).replace('line 20', 'line 20 X')))
    const skips = hunked.filter((l) => l.type === 'skip')
    expect(skips).toHaveLength(2) // before the change, and after it
    expect(skips[0].count).toBe(17)
    expect(skips[0].text).toBe('17 unchanged lines')
  })

  it('folds nothing when every line is a change', () => {
    const hunked = hunkDiff(diffLines('', 'a\nb\nc'))
    expect(hunked.filter((l) => l.type === 'skip')).toHaveLength(0)
    expect(hunked.filter((l) => l.type === 'add')).toHaveLength(3)
  })

  it('returns nothing for an identical file rather than the whole thing as context', () => {
    expect(hunkDiff(diffLines(longFile(50), longFile(50)))).toEqual([])
  })

  it('handles two separate changes as two hunks', () => {
    const before = longFile(60)
    const after = before.replace('line 5', 'line 5 X').replace('line 50', 'line 50 Y')
    const hunked = hunkDiff(diffLines(before, after))
    expect(hunked.filter((l) => l.text.includes('line 5 X'))).toHaveLength(1)
    expect(hunked.filter((l) => l.text.includes('line 50 Y'))).toHaveLength(1)
    expect(hunked.filter((l) => l.type === 'skip').length).toBeGreaterThan(0)
  })

  it('does not let a fold marker distort the stat', () => {
    const hunked = hunkDiff(diffLines(longFile(60), longFile(60).replace('line 30', 'line 30 X')))
    expect(diffStat(hunked)).toEqual({ added: 1, removed: 1 })
  })
})
