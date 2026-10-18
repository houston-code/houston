import { describe, it, expect } from 'vitest'
import {
  appMenuTemplate,
  resolveCloseAction,
  setTerminalFocused,
  isTerminalFocused,
  GUIDE_URL,
  ISSUES_URL
} from './menu'
import { isSafeExternalUrl } from './safeExternal'

describe('menu close routing', () => {
  it('routes Cmd+W to the active tab when the terminal is focused, else the window', () => {
    expect(resolveCloseAction(true)).toBe('close-tab')
    expect(resolveCloseAction(false)).toBe('close-window')
  })

  it('tracks the reported terminal focus state', () => {
    setTerminalFocused(true)
    expect(isTerminalFocused()).toBe(true)
    setTerminalFocused(false)
    expect(isTerminalFocused()).toBe(false)
  })
})

describe('Check for Updates menu item', () => {
  /** Labels of every item in a top-level menu's submenu. */
  const itemLabels = (menu: { submenu?: unknown }): string[] =>
    ((menu.submenu ?? []) as { label?: string }[]).map((i) => i.label ?? '')

  it('is reachable from a Help menu on Windows and Linux', () => {
    const help = appMenuTemplate(false).find((m) => m.role === 'help')
    expect(help).toBeDefined()
    expect(itemLabels(help!)).toContain('Check for Updates…')
  })

  it('stays in the app menu on macOS, with no duplicate Help entry', () => {
    const template = appMenuTemplate(true)
    const all = template.flatMap(itemLabels)
    expect(all.filter((l) => l === 'Check for Updates…')).toHaveLength(1)
  })
})

describe('Share Houston menu item', () => {
  const itemLabels = (menu: { submenu?: unknown }): string[] =>
    ((menu.submenu ?? []) as { label?: string }[]).map((i) => i.label ?? '')

  it('is in the Help menu on Windows and Linux', () => {
    const help = appMenuTemplate(false).find((m) => m.role === 'help')
    expect(itemLabels(help!)).toContain('Share Houston…')
  })

  it('appears exactly once on macOS, in the app menu', () => {
    const template = appMenuTemplate(true)
    expect(itemLabels(template[0])).toContain('Share Houston…')
    expect(template.flatMap(itemLabels).filter((l) => l === 'Share Houston…')).toHaveLength(1)
  })
})

describe('Help menu', () => {
  const itemLabels = (menu: { submenu?: unknown }): string[] =>
    ((menu.submenu ?? []) as { label?: string }[]).map((i) => i.label ?? '')

  it.each([true, false])('is the last menu with the guide and issue links (isMac=%s)', (isMac) => {
    const template = appMenuTemplate(isMac)
    const help = template[template.length - 1]
    // role 'help' is what gives macOS its native menu search field.
    expect(help.role).toBe('help')
    expect(template.filter((m) => m.role === 'help')).toHaveLength(1)
    expect(itemLabels(help).slice(0, 2)).toEqual(['Houston Guide', 'Report an Issue'])
  })

  it('carries only the links on macOS, where share and updates live in the app menu', () => {
    const help = appMenuTemplate(true).at(-1)!
    expect(itemLabels(help)).toEqual(['Houston Guide', 'Report an Issue'])
  })

  it('links to https URLs that pass the external-open allowlist', () => {
    for (const url of [GUIDE_URL, ISSUES_URL]) {
      expect(url.startsWith('https://')).toBe(true)
      expect(isSafeExternalUrl(url)).toBe(true)
    }
  })
})
