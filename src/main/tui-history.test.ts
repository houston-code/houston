import { describe, it, expect } from 'vitest'
import {
  appendHistory,
  parseHistory,
  serializeHistory,
  encodeHistoryLine,
  decodeHistoryLine,
  HISTORY_CAP
} from './tui-history'

describe('appendHistory', () => {
  it('appends trimmed non-empty lines (newest last)', () => {
    expect(appendHistory('  hi  ', ['a'])).toEqual(['a', 'hi'])
  })
  it('skips blanks', () => {
    expect(appendHistory('   ', ['a'])).toEqual(['a'])
  })
  it('drops a consecutive duplicate of the most recent entry', () => {
    expect(appendHistory('a', ['a'])).toEqual(['a'])
    expect(appendHistory('a', ['a', 'b'])).toEqual(['a', 'b', 'a']) // non-consecutive is kept
  })
  it('caps the total, dropping oldest', () => {
    const long = Array.from({ length: HISTORY_CAP }, (_, i) => `l${i}`)
    const out = appendHistory('new', long)
    expect(out).toHaveLength(HISTORY_CAP)
    expect(out[out.length - 1]).toBe('new')
    expect(out[0]).toBe('l1') // l0 dropped
  })
})

describe('parseHistory / serializeHistory', () => {
  it('parses a newline blob, dropping blanks', () => {
    expect(parseHistory('a\n\n b \n')).toEqual(['a', 'b'])
  })
  it('tolerates null/empty', () => {
    expect(parseHistory(null)).toEqual([])
    expect(parseHistory('')).toEqual([])
  })
  it('round-trips', () => {
    expect(parseHistory(serializeHistory(['a', 'b']))).toEqual(['a', 'b'])
  })
  it('serializes empty to empty string', () => {
    expect(serializeHistory([])).toBe('')
  })

  // A pasted block is one history entry. Stored raw it would read back as several
  // bogus one-line entries, and recall would replay only the first line.
  it('round-trips a multi-line entry as a single entry', () => {
    const entry = 'fix this:\n\nfunction f() {\n  return 1\n}'
    const parsed = parseHistory(serializeHistory(['before', entry, 'after']))
    expect(parsed).toEqual(['before', entry, 'after'])
  })

  it('round-trips backslashes without turning them into newlines', () => {
    const entry = 'path C:\\name and a literal \\n'
    expect(parseHistory(serializeHistory([entry]))).toEqual([entry])
  })

  it('encodes an entry onto one physical line', () => {
    expect(encodeHistoryLine('a\nb')).toBe('a\\nb')
    expect(encodeHistoryLine('a\nb').includes('\n')).toBe(false)
    expect(decodeHistoryLine('a\\nb')).toBe('a\nb')
  })
})
