import { describe, expect, it } from 'vitest'
import type { DiffHunk } from '@shared/workingTree'
import { contextRoom, expandHunk, fileLines, hunkMatches, hunkSpan } from './diffContext'

/** A 30-line file whose line 10 became `TEN` and whose line 25 was removed. */
const file = Array.from({ length: 30 }, (_, i) => `line${i + 1}`)
const now = file.map((l) => (l === 'line10' ? 'TEN' : l)).filter((l) => l !== 'line25')
const hunks: DiffHunk[] = [
  {
    header: '@@ -9,3 +9,3 @@ function f()',
    lines: [
      { type: 'ctx', text: 'line9' },
      { type: 'del', text: 'line10' },
      { type: 'add', text: 'TEN' },
      { type: 'ctx', text: 'line11' }
    ]
  },
  {
    header: '@@ -24,3 +24,2 @@',
    lines: [
      { type: 'ctx', text: 'line24' },
      { type: 'del', text: 'line25' },
      { type: 'ctx', text: 'line26' }
    ]
  }
]

describe('diffContext', () => {
  it('splits file text like a diff: no phantom last line, CRLF tolerated, a cut line dropped', () => {
    expect(fileLines('a\nb\n')).toEqual(['a', 'b'])
    expect(fileLines('a\r\nb')).toEqual(['a', 'b'])
    expect(fileLines('a\nb\npart', true)).toEqual(['a', 'b'])
  })

  it('reads where a pure insert or delete sits from its empty side', () => {
    expect(hunkSpan({ header: '@@ -0,0 +1,2 @@', lines: [] })).toMatchObject({ oldFirst: 1, oldCount: 0, newFirst: 1 })
    expect(hunkSpan({ header: '@@ -5,2 +4,0 @@', lines: [] })).toMatchObject({ newFirst: 5, newCount: 0 })
    expect(hunkSpan({ header: 'not a header', lines: [] })).toBeNull()
  })

  it('measures the room between hunks from the headers, and past the last once the file is known', () => {
    expect(contextRoom(hunks, 0, null)).toEqual({ above: 8, below: 12 })
    expect(contextRoom(hunks, 1, null)).toEqual({ above: 12, below: null })
    expect(contextRoom(hunks, 1, now.length)).toEqual({ above: 12, below: 4 })
  })

  it('prepends and appends file lines as context and renumbers the header', () => {
    const up = expandHunk(hunks, 0, now, 3, 2)
    expect(up?.header).toBe('@@ -6,8 +6,8 @@ function f()')
    expect(up?.lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      'ctx:line6',
      'ctx:line7',
      'ctx:line8',
      'ctx:line9',
      'del:line10',
      'add:TEN',
      'ctx:line11',
      'ctx:line12',
      'ctx:line13'
    ])
  })

  it('never reveals past the neighbouring hunk or the ends of the file', () => {
    const top = expandHunk(hunks, 0, now, 100, 100)
    expect(top?.lines[0]).toEqual({ type: 'ctx', text: 'line1' })
    // Stops at line 23, just above the next hunk's first line.
    expect(top?.lines[top.lines.length - 1]).toEqual({ type: 'ctx', text: 'line23' })
    const last = expandHunk(hunks, 1, now, 0, 100)
    expect(last?.lines[last.lines.length - 1]).toEqual({ type: 'ctx', text: 'line30' })
    expect(last?.header).toBe('@@ -24,7 +24,6 @@')
  })

  it('refuses to expand when the file no longer says what the diff says', () => {
    const edited = now.map((l) => (l === 'TEN' ? 'ELEVEN' : l))
    expect(hunkMatches(hunks[0], now)).toBe(true)
    expect(hunkMatches(hunks[0], edited)).toBe(false)
    expect(expandHunk(hunks, 0, edited, 5, 0)).toBeNull()
    expect(expandHunk(hunks, 0, null, 5, 0)).toBeNull()
    // Asking for nothing needs no file at all.
    expect(expandHunk(hunks, 0, null, 0, 0)).toBe(hunks[0])
  })
})
