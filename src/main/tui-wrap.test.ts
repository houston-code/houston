import { describe, it, expect } from 'vitest'
import { stripAnsi, visibleWidth, truncateVisible, wrapAnsi } from './tui-wrap'

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
