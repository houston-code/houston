import { describe, it, expect } from 'vitest'
import { appMenuTemplate, resolveCloseAction, setTerminalFocused, isTerminalFocused } from './menu'

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
    expect(template.find((m) => m.role === 'help')).toBeUndefined()
    const all = template.flatMap(itemLabels)
    expect(all.filter((l) => l === 'Check for Updates…')).toHaveLength(1)
  })
})
