import { describe, it, expect } from 'vitest'
import { numberDiff, wordDiff, renderDiffLines, renderPreviewView } from './tui-diff'
import { diffLines, hunkDiff, type DiffLine } from '@shared/diff'
import { makePainter } from './tui'

const paint = makePainter(false)

describe('numberDiff', () => {
  it('numbers each side independently', () => {
    const d: DiffLine[] = [
      { type: 'ctx', text: 'a' },
      { type: 'del', text: 'b' },
      { type: 'add', text: 'B' },
      { type: 'ctx', text: 'c' }
    ]
    expect(numberDiff(d)).toEqual([
      { type: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { type: 'del', text: 'b', oldNo: 2 },
      { type: 'add', text: 'B', newNo: 2 },
      { type: 'ctx', text: 'c', oldNo: 3, newNo: 3 }
    ])
  })

  // Without this every number after a fold is wrong, which is worse than none.
  it('advances both sides across a fold marker', () => {
    const d: DiffLine[] = [
      { type: 'ctx', text: 'a' },
      { type: 'skip', text: '10 unchanged lines', count: 10 },
      { type: 'del', text: 'x' }
    ]
    const n = numberDiff(d)
    expect(n[2].oldNo).toBe(12) // 1 ctx + 10 folded + this one
  })
})

describe('wordDiff', () => {
  it('marks only the token that changed', () => {
    const { del, add } = wordDiff('const timeout = 30', 'const timeout = 60')
    expect(del.filter(Boolean)).toHaveLength(1)
    expect(add.filter(Boolean)).toHaveLength(1)
  })

  it('marks nothing when the lines match', () => {
    const { del } = wordDiff('same', 'same')
    expect(del.some(Boolean)).toBe(false)
  })

  it('marks the whole line when nothing is shared', () => {
    const { del, add } = wordDiff('alpha beta', 'gamma delta')
    expect(del.every(Boolean)).toBe(true)
    expect(add.every(Boolean)).toBe(true)
  })

  it('handles an insertion into the middle', () => {
    const { add } = wordDiff('a c', 'a b c')
    expect(add.filter(Boolean).length).toBeGreaterThan(0)
  })
})

describe('renderDiffLines', () => {
  it('numbers the gutter', () => {
    const out = renderDiffLines(diffLines('a\nb\nc', 'a\nB\nc'), paint).join('\n')
    expect(out).toMatch(/1 │ a/)
    expect(out).toMatch(/2 - b/)
    expect(out).toMatch(/2 \+ B/)
    expect(out).toMatch(/3 │ c/)
  })

  it('renders a fold marker as an aside, not a line of code', () => {
    const folded = hunkDiff(
      diffLines(
        Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'),
        Array.from({ length: 30 }, (_, i) => (i === 20 ? 'l20 X' : `l${i}`)).join('\n')
      )
    )
    const out = renderDiffLines(folded, paint).join('\n')
    expect(out).toContain('⋯ 17 unchanged lines')
    expect(out).not.toMatch(/[-+] 17 unchanged/) // never with a diff sign
  })

  it('syntax-highlights the code when a highlighter is wired', () => {
    const out = renderDiffLines(diffLines('const a = 1', 'const a = 2'), paint, {
      highlight: (code) => `<hl>${code}</hl>`
    }).join('\n')
    // Context lines go through the highlighter; the changed pair is word-marked.
    expect(out).toContain('- const a = 1')
    expect(out).toContain('+ const a = 2')
  })

  it('caps a huge change and says how much is left', () => {
    const big = diffLines('', Array.from({ length: 200 }, (_, i) => `new ${i}`).join('\n'))
    const out = renderDiffLines(big, paint, { maxLines: 10 }).join('\n')
    expect(out).toContain('more changed lines')
    expect(out).not.toContain('new 199')
  })

  it('renders a pure insertion without inventing a partner', () => {
    const out = renderDiffLines(diffLines('a\nb', 'a\nX\nb'), paint).join('\n')
    expect(out).toContain('+ X')
    expect(out).not.toContain('- X')
  })
})

describe('renderPreviewView', () => {
  const file = (over = {}): Parameters<typeof renderPreviewView>[0][number] => ({
    path: 'src/app.ts',
    diff: diffLines('const a = 1', 'const a = 2'),
    ...over
  })

  it('heads each file with its path and shows the diff', () => {
    const out = renderPreviewView([file()], paint) as string
    expect(out).toContain('src/app.ts')
    expect(out).toContain('- const a = 1')
    expect(out).toContain('+ const a = 2')
  })

  it('tags new, deleted and renamed files', () => {
    expect(renderPreviewView([file({ created: true })], paint)).toContain('(new file)')
    expect(renderPreviewView([file({ deleted: true })], paint)).toContain('(deleted)')
    expect(renderPreviewView([file({ renamedFrom: 'old.ts' })], paint)).toContain('renamed from old.ts')
  })

  it('renders every file a multi-file write touches', () => {
    const out = renderPreviewView([file(), file({ path: 'src/other.ts' })], paint) as string
    expect(out).toContain('src/app.ts')
    expect(out).toContain('src/other.ts')
  })

  // `truncated` now means the CHANGE is enormous, since the file's untouched parts
  // are folded away upstream — so it should say that, not "the file is long".
  it('says a truncated change is too large, not that the file is', () => {
    const out = renderPreviewView([file({ truncated: true })], paint) as string
    expect(out).toContain('too large to show in full')
  })

  it('returns null for a write that touches nothing', () => {
    expect(renderPreviewView([], paint)).toBeNull()
  })
})
