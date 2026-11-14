import { describe, it, expect } from 'vitest'
import { stripAnsi, visibleWidth, truncateVisible, truncateVisibleStart, takeStreamedRows, wrapAnsi } from './tui-wrap'

const RED = '\x1b[31m'
const RESET = '\x1b[0m'

describe('stripAnsi / visibleWidth', () => {
  it('ignores SGR codes when measuring', () => {
    expect(stripAnsi(`${RED}hello${RESET}`)).toBe('hello')
    expect(visibleWidth(`${RED}hello${RESET}`)).toBe(5)
    expect(visibleWidth('plain')).toBe(5)
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
