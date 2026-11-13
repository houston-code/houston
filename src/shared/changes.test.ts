import { describe, expect, it } from 'vitest'
import {
  canRevertHunks,
  fileDiffFromTexts,
  fileDiffSignature,
  hunkStart,
  hunksFromLines,
  parseHunkHeader,
  revertHunkText
} from './changes'
import { diffLines } from './diff'
import { parseUnifiedDiff, type DiffHunk } from './workingTree'

const lines = (n: number, from = 1): string => Array.from({ length: n }, (_, i) => `line ${i + from}`).join('\n') + '\n'

describe('parseHunkHeader / hunkStart', () => {
  it('reads both ranges, defaulting a missing count to 1', () => {
    expect(parseHunkHeader('@@ -3,4 +5,6 @@ fn()')).toEqual({ oldStart: 3, oldCount: 4, newStart: 5, newCount: 6 })
    expect(parseHunkHeader('@@ -3 +5 @@')).toEqual({ oldStart: 3, oldCount: 1, newStart: 5, newCount: 1 })
    expect(parseHunkHeader('nope')).toBeNull()
    expect(hunkStart({ header: '@@ -0,0 +1,2 @@', lines: [] })).toEqual({ old: 1, new: 1 })
    expect(hunkStart({ header: '@@ -10,2 +12,3 @@', lines: [] })).toEqual({ old: 10, new: 12 })
  })
})

describe('hunksFromLines', () => {
  it('builds git-shaped hunks with context and merges nearby changes', () => {
    const before = lines(30)
    const after = before.replace('line 5\n', 'line five\n').replace('line 8\n', 'line eight\n').replace('line 25\n', '')
    const hunks = hunksFromLines(diffLines(before, after))
    expect(hunks.map((h) => h.header)).toEqual(['@@ -2,10 +2,10 @@', '@@ -22,7 +22,6 @@'])
    expect(hunks[0].lines[0]).toEqual({ type: 'ctx', text: 'line 2' })
  })

  it('matches the hunks git itself would print for the same edit', () => {
    const before = lines(10)
    const after = before.replace('line 6\n', 'six\n')
    const git = parseUnifiedDiff(
      ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -3,7 +3,7 @@', ' line 3', ' line 4', ' line 5', '-line 6', '+six', ' line 7', ' line 8', ' line 9', ''].join('\n')
    )[0].hunks
    expect(hunksFromLines(diffLines(before, after))).toEqual(git)
  })

  it('uses the line before for an empty side, as git does', () => {
    expect(fileDiffFromTexts('n', null, 'a\nb\n').hunks[0].header).toBe('@@ -0,0 +1,2 @@')
    expect(fileDiffFromTexts('n', 'a\n', null).hunks[0].header).toBe('@@ -1,1 +0,0 @@')
  })
})

describe('fileDiffFromTexts', () => {
  it('marks created, deleted and edited files and counts lines', () => {
    expect(fileDiffFromTexts('a', null, 'x\n')).toMatchObject({ status: 'added', added: 1, removed: 0 })
    expect(fileDiffFromTexts('a', 'x\n', null)).toMatchObject({ status: 'deleted', added: 0, removed: 1 })
    expect(fileDiffFromTexts('a', 'x\ny\n', 'x\nz\n')).toMatchObject({ status: 'modified', added: 1, removed: 1 })
  })
})

describe('fileDiffSignature', () => {
  it('changes with any line of the diff and stays put otherwise', () => {
    const a = fileDiffFromTexts('f', 'x\ny\n', 'x\nz\n')
    expect(fileDiffSignature(a)).toBe(fileDiffSignature(fileDiffFromTexts('f', 'x\ny\n', 'x\nz\n')))
    expect(fileDiffSignature(a)).not.toBe(fileDiffSignature(fileDiffFromTexts('f', 'x\ny\n', 'x\nw\n')))
    expect(fileDiffSignature(a)).not.toBe(fileDiffSignature(fileDiffFromTexts('g', 'x\ny\n', 'x\nz\n')))
  })
})

describe('canRevertHunks', () => {
  it('allows hunks only for edited text files', () => {
    expect(canRevertHunks(fileDiffFromTexts('f', 'a\n', 'b\n'))).toBe(true)
    expect(canRevertHunks(fileDiffFromTexts('f', null, 'b\n'))).toBe(false)
    expect(canRevertHunks({ ...fileDiffFromTexts('f', 'a\n', 'b\n'), status: 'untracked' })).toBe(false)
    expect(canRevertHunks({ ...fileDiffFromTexts('f', 'a\n', 'b\n'), binary: true })).toBe(false)
  })
})

describe('revertHunkText', () => {
  it('undoes one hunk and leaves the others', () => {
    const before = lines(30)
    const after = before.replace('line 5\n', 'line five\n').replace('line 25\n', 'line 25\nadded\n')
    const hunks = hunksFromLines(diffLines(before, after))
    expect(hunks).toHaveLength(2)
    const once = revertHunkText(after, hunks[1])
    expect(once).toBe(before.replace('line 5\n', 'line five\n'))
    // The other hunk still applies to the half-reverted file: its lines did not move.
    expect(revertHunkText(once!, hunks[0])).toBe(before)
  })

  it('refuses when the file no longer holds the hunk', () => {
    const before = lines(10)
    const after = before.replace('line 4\n', 'four\n')
    const [hunk] = hunksFromLines(diffLines(before, after))
    expect(revertHunkText(after.replace('line 3\n', 'three\n'), hunk)).toBeNull()
    expect(revertHunkText('', hunk)).toBeNull()
    expect(revertHunkText(after, { header: 'garbage', lines: hunk.lines })).toBeNull()
  })

  it('reverts a pure insertion and a pure deletion', () => {
    const ins = hunksFromLines(diffLines('a\nb\n', 'a\nnew\nb\n'))[0]
    expect(revertHunkText('a\nnew\nb\n', ins)).toBe('a\nb\n')
    const del = hunksFromLines(diffLines('a\nold\nb\n', 'a\nb\n'))[0]
    expect(revertHunkText('a\nb\n', del)).toBe('a\nold\nb\n')
    // Deleting everything a file held, put back.
    const all = hunksFromLines(diffLines('x\n', ''))[0]
    expect(revertHunkText('', all)).toBe('x')
  })

  it('keeps CRLF line endings and a missing final newline', () => {
    const hunk: DiffHunk = {
      header: '@@ -1,2 +1,2 @@',
      lines: [
        { type: 'ctx', text: 'a' },
        { type: 'del', text: 'b' },
        { type: 'add', text: 'c' }
      ]
    }
    expect(revertHunkText('a\r\nc\r\nd\r\n', hunk)).toBe('a\r\nb\r\nd\r\n')
    expect(revertHunkText('a\r\nc', hunk)).toBe('a\r\nb')
    expect(revertHunkText('a\nc', hunk)).toBe('a\nb')
  })
})
