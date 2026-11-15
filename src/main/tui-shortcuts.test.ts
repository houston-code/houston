import { describe, it, expect } from 'vitest'
import { keysSection, shortcutLines, shortcutOverlayRows, shortcutPlainLines } from './tui-shortcuts'
import { HELP_TEXT, makePainter } from './tui'
import { visibleWidth } from './tui-wrap'

const paint = makePainter(false)

describe('keysSection', () => {
  it('is the Keys section of /help, without its heading', () => {
    const keys = keysSection(HELP_TEXT)
    expect(keys.length).toBeGreaterThan(5)
    expect(keys[0]).toMatch(/^ {2}Enter/)
    expect(keys.some((l) => l.includes('Ctrl-R'))).toBe(true)
    expect(keys.some((l) => l.trim().startsWith('?'))).toBe(true)
    // It stops at the blank line: nothing from the sections after it.
    expect(keys.some((l) => l.includes('Approvals'))).toBe(false)
  })

  it('is empty for a help text without one', () => {
    expect(keysSection('Commands:\n  /help')).toEqual([])
  })
})

describe('shortcutLines', () => {
  it('adds the user bindings under their own heading', () => {
    expect(shortcutLines(['  Enter  send'], [])).toEqual(['Keys:', '  Enter  send'])
    expect(shortcutLines(['  Enter  send'], ['  composer:', '    Ctrl-T  transcript'])).toEqual([
      'Keys:',
      '  Enter  send',
      '',
      'Your keybindings (~/.houston/keybindings.json):',
      '  composer:',
      '    Ctrl-T  transcript'
    ])
  })
})

describe('shortcutOverlayRows', () => {
  const lines = shortcutLines(keysSection(HELP_TEXT), [])

  it('fits every row to the width and ends with how to close it', () => {
    const rows = shortcutOverlayRows(lines, { width: 30, rows: 100, paint })
    expect(rows.every((r) => visibleWidth(r) <= 30)).toBe(true)
    expect(rows.at(-1)).toContain('any key closes this')
    expect(rows).toHaveLength(lines.length + 1)
  })

  it('cuts to the terminal height and says how much is left', () => {
    const rows = shortcutOverlayRows(lines, { width: 80, rows: 10, paint })
    expect(rows).toHaveLength(8)
    expect(rows.at(-2)).toMatch(/^… \d+ more in \/help$/)
  })

  it('strips control characters a binding could carry', () => {
    const rows = shortcutOverlayRows(['  x \x1b[31mred'], { width: 80, rows: 10, paint })
    expect(rows[0]).not.toContain('\x1b')
  })
})

describe('shortcutPlainLines', () => {
  it('is every line, plain, then an end marker', () => {
    expect(shortcutPlainLines(['Keys:', '  Enter  send\x07'])).toEqual(['Keys:', '  Enter  send', 'end of keys'])
  })
})
