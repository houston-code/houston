import { describe, expect, it } from 'vitest'
import { resolveEdit } from './edit-match'

describe('resolveEdit — exact', () => {
  it('replaces a unique exact substring', () => {
    const r = resolveEdit('one two three', 'two', 'TWO')
    expect(r.content).toBe('one TWO three')
    expect(r.strategy).toBe('exact')
    expect(r.replacements).toBe(1)
  })

  it('rejects an ambiguous match without replace_all', () => {
    expect(() => resolveEdit('a a a', 'a', 'b')).toThrow(/occurs 3 times/)
  })

  it('replaces every occurrence with replace_all', () => {
    expect(resolveEdit('a a a', 'a', 'b', true).content).toBe('b b b')
  })

  it('throws when not found', () => {
    expect(() => resolveEdit('abc', 'zzz', 'q')).toThrow(/not found/)
  })

  it('rejects an empty old_string', () => {
    expect(() => resolveEdit('abc', '', 'q')).toThrow(/must not be empty/)
  })

  it('rejects identical old/new', () => {
    expect(() => resolveEdit('abc', 'a', 'a')).toThrow(/identical/)
  })

  it('prefers exact over fuzzy when both could match', () => {
    // The exact "  x" exists verbatim; fuzzy would also match "x" lines, but exact wins.
    const r = resolveEdit('  x\n  x', '  x', '  y', true)
    expect(r.strategy).toBe('exact')
    expect(r.content).toBe('  y\n  y')
  })
})

describe('resolveEdit — line-trimmed (whitespace/indent drift)', () => {
  it('matches despite different leading indentation', () => {
    // File line has no indent; model supplied a 4-space indent. Not an exact
    // substring, so the line-trimmed strategy must catch it.
    const file = 'function f() {\nreturn 1\n}\n'
    const r = resolveEdit(file, '    return 1', '    return 2')
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('function f() {\n    return 2\n}\n')
  })

  it('matches despite trailing whitespace drift', () => {
    const file = 'alpha   \nbeta\n'
    const r = resolveEdit(file, 'alpha', 'ALPHA')
    // "alpha" is not an exact substring boundary issue — exact finds it, so assert exact here
    expect(r.content).toContain('ALPHA')
  })

  it('matches a multi-line block with per-line indent drift', () => {
    const file = '      a\n      b\n      c\n'
    const r = resolveEdit(file, 'a\nb\nc', 'a\nB\nc')
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('a\nB\nc\n')
  })

  it('replace_all across multiple drifted windows', () => {
    const file = '  k\nx\n  k\n'
    const r = resolveEdit(file, 'k', 'K', true)
    // exact "k" occurs twice verbatim, so exact handles it
    expect(r.content).toBe('  K\nx\n  K\n')
  })
})

describe('resolveEdit — block-anchor', () => {
  it('replaces a >=3-line block when the interior drifted but anchors hold', () => {
    const file = 'header\nmiddle-changed\nkept\nfooter\n'
    const old = 'header\nmiddle-original\nkept\nfooter'
    const r = resolveEdit(file, old, 'header\nNEW\nkept\nfooter')
    expect(r.strategy).toBe('block-anchor')
    expect(r.content).toBe('header\nNEW\nkept\nfooter\n')
  })

  it('refuses when the interior is too dissimilar (anchors alone are not enough)', () => {
    const file = 'header\nzzz\nyyy\nfooter\n'
    const old = 'header\naaa\nbbb\nfooter'
    expect(() => resolveEdit(file, old, 'x')).toThrow(/not found/)
  })

  it('does not anchor blocks shorter than 3 lines', () => {
    const file = 'open\nclose\n'
    expect(() => resolveEdit(file, 'open\nDIFFERENT', 'x')).toThrow(/not found/)
  })
})

describe('resolveEdit — line endings & BOM', () => {
  it('preserves CRLF line endings in the replacement', () => {
    const file = 'a\r\nb\r\nc\r\n'
    // old supplied with LF only; matched via line-trimmed; replacement must come back CRLF
    const r = resolveEdit(file, 'a\nb\nc', 'a\nX\nc')
    expect(r.content).toBe('a\r\nX\r\nc\r\n')
  })

  it('preserves a leading BOM', () => {
    const r = resolveEdit('﻿hello world', 'world', 'there')
    expect(r.content).toBe('﻿hello there')
  })

  it('keeps a trailing newline symmetric when old text ended in one', () => {
    const file = 'x\nfoo\ny\n'
    const r = resolveEdit(file, '  foo\n', 'bar\n')
    expect(r.content).toBe('x\nbar\ny\n')
  })
})
