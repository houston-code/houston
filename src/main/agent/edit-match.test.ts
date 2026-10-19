import { describe, expect, it } from 'vitest'
import { EditNotFoundError, resolveEdit } from './edit-match'

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

describe('resolveEdit — regions', () => {
  it('reports where each replacement landed in the edited content', () => {
    const r = resolveEdit('a\nb\nc\nb\n', 'b', 'B1\nB2', true)
    expect(r.content).toBe('a\nB1\nB2\nc\nB1\nB2\n')
    // The second region starts one line later than its original line 4, because
    // the first replacement added a line above it.
    expect(r.regions).toEqual([
      { startLine: 2, lineCount: 2, lineDelta: 1 },
      { startLine: 5, lineCount: 2, lineDelta: 1 }
    ])
  })

  it('reports a deletion as a zero-line region with a negative delta', () => {
    const r = resolveEdit('keep\ndrop1\ndrop2\nkeep2\n', 'drop1\ndrop2\n', '')
    expect(r.content).toBe('keep\nkeep2\n')
    expect(r.regions).toEqual([{ startLine: 2, lineCount: 0, lineDelta: -2 }])
  })

  it('counts lines across CRLF and a BOM the same as LF', () => {
    const r = resolveEdit('﻿a\r\nb\r\nc\r\n', 'c', 'C')
    expect(r.regions).toEqual([{ startLine: 3, lineCount: 1, lineDelta: 0 }])
  })
})

describe('resolveEdit — copied line numbers', () => {
  it('strips read_file prefixes from old_string and new_string when old only matches without them', () => {
    const r = resolveEdit('one\ntwo\nthree\n', '2\ttwo\n3\tthree', '2\tTWO\n3\tTHREE')
    expect(r.content).toBe('one\nTWO\nTHREE\n')
    expect(r.strippedLineNumbers).toBe('both')
  })

  it('strips old_string alone when new_string was written fresh', () => {
    const r = resolveEdit('one\ntwo\n', ' 2\ttwo', 'TWO')
    expect(r.content).toBe('one\nTWO\n')
    expect(r.strippedLineNumbers).toBe('old')
  })

  it('never alters numbered-looking text that really is in the file', () => {
    // A tab-separated table whose first column counts up: matched as written, so
    // neither string is stripped.
    const file = 'id\tname\n1\talice\n2\tbob\n'
    const r = resolveEdit(file, '1\talice\n2\tbob', '1\talice\n2\tbobby')
    expect(r.content).toBe('id\tname\n1\talice\n2\tbobby\n')
    expect(r.strippedLineNumbers).toBeUndefined()
  })

  it('leaves new_string numbered when not every line carries a prefix', () => {
    const r = resolveEdit('one\ntwo\n', '2\ttwo', '2\ttwo\nadded')
    expect(r.content).toBe('one\n2\ttwo\nadded\n')
    expect(r.strippedLineNumbers).toBe('old')
  })

  it('does not strip prefixes whose numbers skip, as copied text never does', () => {
    expect(() => resolveEdit('one\ntwo\nthree\n', '1\tone\n3\tthree', 'x')).toThrow(/not found/)
  })

  it('refuses a stripped edit that would change nothing', () => {
    expect(() => resolveEdit('one\ntwo\n', '2\ttwo', 'two')).toThrow(/identical/)
  })
})

describe('resolveEdit — closest region when not found', () => {
  const file = [
    'function add(a, b) {',
    '  return a + b',
    '}',
    '',
    'function scale(v, k) {',
    '  const out = v * k',
    '  return out',
    '}',
    ''
  ].join('\n')

  it('names and numbers the most similar region', () => {
    let msg = ''
    try {
      resolveEdit(file, 'function scale(v, factor) {\n  const out = v * factor', 'x')
    } catch (e) {
      expect(e).toBeInstanceOf(EditNotFoundError)
      expect((e as EditNotFoundError).hasCandidate).toBe(true)
      msg = (e as Error).message
    }
    expect(msg).toMatch(/^old_string was not found in the file\. The closest match is lines 5-6 \(\d+% similar\):\n/)
    expect(msg).toContain('5\tfunction scale(v, k) {\n6\t  const out = v * k\n')
  })

  it('says nothing is close rather than offering an unrelated region', () => {
    let err: unknown
    try {
      resolveEdit(file, 'class Totally { different() }', 'x')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(EditNotFoundError)
    expect((err as EditNotFoundError).hasCandidate).toBe(false)
    expect((err as Error).message).toMatch(/no part of the file is close to it\. Read the file again/)
  })

  it('looks for the stripped text when old_string carried copied line numbers', () => {
    expect(() => resolveEdit(file, '6\t  const out = v * kk\n7\t  return out', 'x')).toThrow(
      /closest match is lines 6-7/
    )
  })

  it('cuts a long candidate region short', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
    const needle = Array.from({ length: 60 }, (_, i) => `line ${i} changed`).join('\n')
    expect(() => resolveEdit(big, needle, 'x')).toThrow(/lines 1-60 .*\n[\s\S]*\n\[20 more lines not shown\]/)
  })
})
