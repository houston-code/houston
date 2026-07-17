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

  it('rejects identical old/new with a hint that it changes nothing', () => {
    expect(() => resolveEdit('abc', 'a', 'a')).toThrow(/identical/)
    expect(() => resolveEdit('abc', 'a', 'a')).toThrow(/make no change|differ from the original/i)
  })

  it('prefers exact over fuzzy when both could match', () => {
    // The exact "  x" exists verbatim; fuzzy would also match "x" lines, but exact wins.
    const r = resolveEdit('  x\n  x', '  x', '  y', true)
    expect(r.strategy).toBe('exact')
    expect(r.content).toBe('  y\n  y')
  })
})

describe('resolveEdit — line-trimmed (whitespace/indent drift)', () => {
  it('matches despite different leading indentation and re-adapts to the file', () => {
    // File line has no indent; model supplied a 4-space indent. Not an exact
    // substring, so the line-trimmed strategy must catch it — and the replacement
    // is re-indented to the file's (zero) indentation, not the model's 4 spaces.
    const file = 'function f() {\nreturn 1\n}\n'
    const r = resolveEdit(file, '    return 1', '    return 2')
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('function f() {\nreturn 2\n}\n')
  })

  it('matches despite trailing whitespace drift', () => {
    const file = 'alpha   \nbeta\n'
    const r = resolveEdit(file, 'alpha', 'ALPHA')
    // "alpha" is not an exact substring boundary issue — exact finds it, so assert exact here
    expect(r.content).toContain('ALPHA')
  })

  it('matches a multi-line block with per-line indent drift and preserves the indent', () => {
    // The model's old/new are at column 0; the file block is indented 6 spaces.
    // The replacement must land at the file's indentation, not flatten it.
    const file = '      a\n      b\n      c\n'
    const r = resolveEdit(file, 'a\nb\nc', 'a\nB\nc')
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('      a\n      B\n      c\n')
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

describe('resolveEdit — indentation re-adaptation', () => {
  it('re-bases the whole block onto the file indent while keeping inner nesting', () => {
    // File block sits at 4 spaces with a further-nested inner line; model authored
    // old/new at column 0. Re-indent must add 4 to every line AND keep the inner
    // line one level deeper.
    const file = '    if (x) {\n        y()\n    }\n'
    const old = 'if (x) {\n    y()\n}'
    const next = 'if (x) {\n    z()\n}'
    const r = resolveEdit(file, old, next)
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('    if (x) {\n        z()\n    }\n')
  })

  it('re-indents each match independently under replace_all', () => {
    // Two matches at different indentations; each replacement adapts to its own block.
    // Both lines are indented so exact can't pre-empt the line-trimmed tier.
    const file = '  a\n  b\n    a\n    b\n'
    const r = resolveEdit(file, 'a\nb', 'a\nB', true)
    expect(r.strategy).toBe('line-trimmed')
    expect(r.content).toBe('  a\n  B\n    a\n    B\n')
  })

  it('re-indents a block-anchor replacement to the file block', () => {
    // 4-line block: one interior line kept, one drifted — only block-anchor fires.
    const file = '    header\n    keep\n    changed\n    footer\n'
    const old = 'header\nkeep\noriginal\nfooter'
    const r = resolveEdit(file, old, 'header\nkeep\nNEW\nfooter')
    expect(r.strategy).toBe('block-anchor')
    expect(r.content).toBe('    header\n    keep\n    NEW\n    footer\n')
  })

  it('re-indents in CRLF space and preserves CRLF endings', () => {
    const file = '\tfoo\r\n\tbar\r\n'
    const r = resolveEdit(file, 'foo\nbar', 'foo\nBAR')
    expect(r.content).toBe('\tfoo\r\n\tBAR\r\n')
  })

  it('leaves a blank replacement line blank rather than indenting it', () => {
    const file = '    a\n    b\n'
    const r = resolveEdit(file, 'a\nb', 'a\n\nb')
    expect(r.content).toBe('    a\n\n    b\n')
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

  it('does not rewrite untouched lines on a mixed line-ending file', () => {
    // Line 2 uses a bare LF; the rest CRLF. Editing line 1 must leave line 2's LF as-is
    // (the old blanket re-encode flipped every LF to CRLF, churning untouched lines).
    const file = 'a\r\nb\nc\r\n'
    const r = resolveEdit(file, 'a', 'A')
    expect(r.content).toBe('A\r\nb\nc\r\n')
  })

  it('keeps a trailing newline symmetric when old text ended in one', () => {
    const file = 'x\nfoo\ny\n'
    const r = resolveEdit(file, '  foo\n', 'bar\n')
    expect(r.content).toBe('x\nbar\ny\n')
  })
})
