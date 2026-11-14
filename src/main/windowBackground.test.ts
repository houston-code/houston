import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WINDOW_BACKGROUND, windowBackground } from './windowBackground'

const css = readFileSync(join(__dirname, '../renderer/src/styles/global.css'), 'utf8')

/** The `--bg` declared directly in the first block for `selector`. */
function pageBackground(selector: string): string | undefined {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return undefined
  const body = css.slice(start, css.indexOf('\n}', start))
  return /--bg:\s*(#[0-9a-fA-F]{6})\s*;/.exec(body)?.[1]
}

describe('windowBackground', () => {
  it('uses the saved theme whatever the OS appearance', () => {
    expect(windowBackground('dark', false)).toBe(WINDOW_BACKGROUND.dark)
    expect(windowBackground('light', true)).toBe(WINDOW_BACKGROUND.light)
  })

  it('follows the OS for "system" and before settings can be read', () => {
    expect(windowBackground('system', true)).toBe(WINDOW_BACKGROUND.dark)
    expect(windowBackground('system', false)).toBe(WINDOW_BACKGROUND.light)
    expect(windowBackground(undefined, true)).toBe(WINDOW_BACKGROUND.dark)
    expect(windowBackground(undefined, false)).toBe(WINDOW_BACKGROUND.light)
  })

  it('matches the page background of each palette, so nothing flashes', () => {
    expect(pageBackground(':root')).toBe(WINDOW_BACKGROUND.dark)
    expect(pageBackground(":root[data-theme='light']")).toBe(WINDOW_BACKGROUND.light)
  })
})
