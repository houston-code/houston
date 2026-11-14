import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ansiPalette, DARK_ANSI, LIGHT_ANSI } from './terminalPalette'

// The integrated terminal draws on --bg-code. In the light themes that background is
// pale, so every ANSI colour a program prints (white and bright yellow included) has to
// read there, with each code theme.

const css = readFileSync(join(__dirname, '..', 'styles', 'global.css'), 'utf8')

function bgCode(selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block`)
  const body = css.slice(start, css.indexOf('\n}', start))
  const m = body.match(/--bg-code:\s*(#[0-9a-fA-F]{6})\s*;/)
  if (!m) throw new Error(`no --bg-code in ${selector}`)
  return m[1]
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

describe('terminal ANSI palette', () => {
  it('follows the resolved theme', () => {
    expect(ansiPalette('light')).toBe(LIGHT_ANSI)
    expect(ansiPalette('dark')).toBe(DARK_ANSI)
    expect(ansiPalette(undefined)).toBe(DARK_ANSI)
  })

  it.each([
    ":root[data-theme='light']",
    ":root[data-theme='light'][data-code-theme='contrast']",
    ":root[data-theme='light'][data-code-theme='muted']"
  ])('every light colour reads at 4.5:1 on %s', (selector) => {
    const bg = bgCode(selector)
    for (const [name, fg] of Object.entries(LIGHT_ANSI)) {
      expect(contrast(fg, bg), `${name} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
