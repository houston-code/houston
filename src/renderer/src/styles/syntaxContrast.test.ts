import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Code blocks and the Files preview draw highlight.js tokens in --syn-* colors on
// --bg-code, inside panels on --bg / --bg-elevated. Every token is body-size text,
// so each one has to clear WCAG AA (4.5:1) on all three surfaces, in both themes.

const css = readFileSync(join(__dirname, 'global.css'), 'utf8')

/** The custom properties declared directly in the first block for `selector`. */
function themeVars(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block`)
  const body = css.slice(start, css.indexOf('\n}', start))
  const vars: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) vars[m[1]] = m[2]
  return vars
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

const TOKENS = ['comment', 'keyword', 'string', 'number', 'function', 'type', 'tag', 'attr', 'meta']
const SURFACES = ['--bg-code', '--bg', '--bg-elevated']

describe.each([
  ['dark', ':root'],
  ['light', ":root[data-theme='light']"]
])('%s syntax tokens', (_theme, selector) => {
  const vars = themeVars(selector)

  it.each(TOKENS)('--syn-%s clears 4.5:1 on every code surface', (token) => {
    const fg = vars[`--syn-${token}`]
    expect(fg).toBeDefined()
    for (const surface of SURFACES) {
      expect(contrast(fg, vars[surface]), `--syn-${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('titlebar count badge', () => {
  it('fills with --accent-fill, the accent shade white text is checked against', () => {
    const start = css.indexOf('.titlebar__badge {')
    const body = css.slice(start, css.indexOf('}', start))
    expect(body).toMatch(/background:\s*var\(--accent-fill\)/)
    for (const selector of [':root', ":root[data-theme='light']"]) {
      expect(contrast('#ffffff', themeVars(selector)['--accent-fill'])).toBeGreaterThanOrEqual(4.5)
    }
  })
})
