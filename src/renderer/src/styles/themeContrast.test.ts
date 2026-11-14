import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Contrast and focus guarantees the stylesheet makes outside the syntax colors
// (syntaxContrast.test.ts covers those and the accent presets): small signal text in
// the sidebar, dim text that is no longer faded with opacity, white text on accent
// fills, and solid focus rings where the faint shared --ring used to be the only cue.

const raw = readFileSync(join(__dirname, 'global.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every custom property declared directly in the first block for `selector`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`no ${selector} block`)
  const body = css.slice(start, css.indexOf('\n}', start))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
}

/** A token's hex value, following `var(--x)` references within the palette. */
function hexOf(vars: Record<string, string>, name: string): string {
  let value = vars[name]
  for (let i = 0; value && i < 5; i++) {
    const ref = /^var\((--[\w-]+)\)$/.exec(value)
    if (!ref) break
    value = vars[ref[1]]
  }
  if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${name} is not a hex color (${value})`)
  return value
}

/** The declarations of the first top-level rule whose selector list names `selector`. */
function ruleFor(selector: string): string {
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2]
  }
  throw new Error(`no rule for ${selector}`)
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

const dark = block(':root')
const light = { ...dark, ...block(":root[data-theme='light']") }

describe.each([
  ['dark', dark],
  ['light', light]
])('%s palette', (_theme, vars) => {
  // A sidebar row sits on the sidebar (--bg-elevated), and on hover or selection.
  const ROW_SURFACES = ['--bg-elevated', '--bg-hover', '--bg-selected']

  it.each(['--sig-input-text', '--sig-error-text', '--sig-unread-text'])(
    '%s clears 4.5:1 on every sidebar row surface',
    (token) => {
      for (const surface of ROW_SURFACES) {
        expect(contrast(hexOf(vars, token), hexOf(vars, surface)), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it('--text-dim clears 4.5:1 on every surface, so it needs no extra fading', () => {
    for (const surface of ['--bg', '--bg-elevated', '--bg-input', '--bg-hover', '--bg-selected']) {
      expect(contrast(hexOf(vars, '--text-dim'), hexOf(vars, surface)), `--text-dim on ${surface}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('sidebar signal text', () => {
  it.each([
    [".conv[data-signal='input'] .conv__reason", '--sig-input-text'],
    [".conv[data-signal='error'] .conv__reason", '--sig-error-text'],
    ['.conv__tag--input', '--sig-input-text'],
    ['.conv__tag--error', '--sig-error-text'],
    ['.conv__tag--unread', '--sig-unread-text']
  ])('%s uses the text shade of its signal', (selector, token) => {
    expect(ruleFor(selector)).toMatch(new RegExp(`(^|[^-])color:\\s*var\\(${token}\\)`))
  })
})

describe('dim text', () => {
  it.each([
    '.menu__item-count',
    '.section-head__count',
    '.section__empty',
    '.statusbar__model',
    '.diff__no',
    '.custom-item--off .custom-item__name',
    '.sched-item--paused .sched-item__name'
  ])('%s is not faded with opacity', (selector) => {
    expect(ruleFor(selector)).not.toMatch(/opacity/)
  })

  it('leaves search-dimmed Settings pages at the nav color instead of fading them', () => {
    expect(() => ruleFor('.modal__nav button.is-dim')).toThrow()
  })
})

describe('text on accent fills', () => {
  it.each([
    '.question__option--on .question__option-desc',
    '.plan-panel__accept kbd',
    ":root[data-theme='light'] .msg__chip-detail"
  ])('%s is solid white', (selector) => {
    expect(ruleFor(selector)).toMatch(/(^|[^-])color:\s*#fff;/)
  })

  it('keeps the running-tasks count readable on its grey badge in both themes', () => {
    expect(contrast(dark['--bg'], dark['--sig-working'])).toBeGreaterThanOrEqual(4.5)
    expect(ruleFor(":root[data-theme='light'] .bgtasks__count[data-running]")).toMatch(/color:\s*#fff;/)
    expect(contrast('#ffffff', light['--sig-working'])).toBeGreaterThanOrEqual(4.5)
    // The ring pulses; the digit itself is never animated.
    expect(ruleFor('.bgtasks__count[data-running]')).not.toMatch(/animation/)
  })
})

describe('focus rings', () => {
  it.each([
    '.coachmark__skip:focus-visible',
    '.connect-model__tile:focus-visible',
    '.connect-model__link:focus-visible',
    ".field input[type='checkbox']:focus-visible",
    '.attach-menu__item:focus-visible',
    '.set-nav__back:focus-visible'
  ])('%s draws a solid accent outline, not the faint shared ring', (selector) => {
    const rule = ruleFor(selector)
    expect(rule).toMatch(/outline:\s*2px solid var\(--accent\)/)
    expect(rule).not.toMatch(/var\(--ring\)/)
  })

  it('keeps Settings checkboxes out of the text-input focus rule that hides the outline', () => {
    expect(() => ruleFor('.field input:focus')).toThrow()
    expect(ruleFor(".field input:not([type='checkbox']):focus")).toMatch(/outline:\s*none/)
  })

  it('restores a system-colored outline in forced-colors mode', () => {
    expect(css).toMatch(/@media \(forced-colors: active\) \{\s*:focus-visible[^{]*\{[^}]*outline:\s*2px solid Highlight/)
  })
})

describe('floating surfaces', () => {
  it.each(['.menu', '.model-warn-tip', '.tt', '.mention-menu', '.history-search', '.find-bar', '.usage-panel'])(
    '%s lifts with the theme-aware popover shadow',
    (selector) => {
      expect(ruleFor(selector)).toMatch(/box-shadow:\s*var\(--shadow-popover\)/)
    }
  )
})

describe('first paint', () => {
  it('paints the light page background before data-theme is set when the OS is light', () => {
    const pre = /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme\]\) \{([^}]*)\}/.exec(css)
    expect(pre).not.toBeNull()
    expect(pre![1]).toMatch(new RegExp(`--bg:\\s*${light['--bg']};`))
  })
})
