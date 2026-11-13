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

// Accent presets: on dark, --accent is read on the panel surfaces and --accent-fill
// carries white text; on light, --accent carries white text (the user's bubbles) and
// is read on the warm surfaces. The default accent is held to the same rules.
describe.each(['default', 'violet', 'green', 'orange', 'pink'])('%s accent', (accent) => {
  const preset = (selector: string): Record<string, string> => (accent === 'default' ? {} : themeVars(selector))
  const dark = { ...themeVars(':root'), ...preset(`:root:not([data-theme='light'])[data-accent='${accent}']`) }
  const light = {
    ...themeVars(':root'),
    ...themeVars(":root[data-theme='light']"),
    ...preset(`:root[data-theme='light'][data-accent='${accent}']`)
  }

  it('reads on the dark surfaces, and its dark fill carries white text', () => {
    for (const surface of ['--bg', '--bg-elevated', '--bg-input']) {
      expect(contrast(dark['--accent'], dark[surface]), `--accent on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
    expect(contrast('#ffffff', dark['--accent-fill'])).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#ffffff', dark['--accent-fill-hover'])).toBeGreaterThanOrEqual(4.5)
  })

  it('carries white text in light, and reads on the light surfaces', () => {
    for (const fill of ['--accent', '--accent-fill', '--accent-fill-hover']) {
      expect(contrast('#ffffff', light[fill]), `white on ${fill}`).toBeGreaterThanOrEqual(4.5)
    }
    for (const surface of ['--bg', '--bg-elevated', '--bg-hover']) {
      expect(contrast(light['--accent'], light[surface]), `--accent on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

// Each code theme overrides the tokens and the code surface for both palettes; the
// panel surfaces (--bg, --bg-elevated) stay the base theme's.
describe.each([
  ['contrast', 'dark', ':root', ":root:not([data-theme='light'])[data-code-theme='contrast']"],
  ['contrast', 'light', ":root[data-theme='light']", ":root[data-theme='light'][data-code-theme='contrast']"],
  ['muted', 'dark', ':root', ":root:not([data-theme='light'])[data-code-theme='muted']"],
  ['muted', 'light', ":root[data-theme='light']", ":root[data-theme='light'][data-code-theme='muted']"]
])('%s code theme, %s syntax tokens', (_name, _theme, base, override) => {
  const vars = { ...themeVars(':root'), ...themeVars(base), ...themeVars(override) }

  it('overrides every token and the code surface', () => {
    const own = themeVars(override)
    for (const token of TOKENS) expect(own[`--syn-${token}`], `--syn-${token}`).toBeDefined()
    expect(own['--bg-code']).toBeDefined()
  })

  it.each(TOKENS)('--syn-%s clears 4.5:1 on every code surface', (token) => {
    const fg = vars[`--syn-${token}`]
    for (const surface of SURFACES) {
      expect(contrast(fg, vars[surface]), `--syn-${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('appearance defaults', () => {
  it('leave the transcript and diffs exactly as before when no option is set', () => {
    const vars = (() => {
      const start = css.indexOf(':root {\n  --chat-zoom')
      const body = css.slice(start, css.indexOf('\n}', start))
      return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
    })()
    expect(vars).toMatchObject({
      '--chat-zoom': '1',
      '--chat-row-gap': '18px',
      '--msg-turn-gap': '10px',
      '--msg-line-height': '1.65',
      '--diff-add-bg': 'rgba(74, 222, 128, 0.13)',
      '--diff-del-bg': 'rgba(255, 107, 107, 0.13)'
    })
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
