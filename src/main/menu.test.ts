import { describe, it, expect, vi } from 'vitest'

// Menu clicks send commands to the focused window; capture what they send.
const sentCommands = vi.hoisted(() => [] as unknown[])
vi.mock('electron', () => {
  const win = { webContents: { send: (_channel: string, cmd: unknown) => sentCommands.push(cmd) } }
  return {
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) },
    BrowserWindow: { getFocusedWindow: () => win, getAllWindows: () => [win] },
    dialog: {},
    app: { getVersion: () => '0.0.0-test', getName: () => 'Houston', getPath: () => '/tmp', on: () => {} },
    shell: {}
  }
})
import {
  appMenuTemplate,
  bindingToAccelerator,
  recentFolderLabel,
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

  it.each([true, false])('is the last menu: the tour, then the guide and issue links (isMac=%s)', (isMac) => {
    const template = appMenuTemplate(isMac)
    const help = template[template.length - 1]
    // role 'help' is what gives macOS its native menu search field.
    expect(help.role).toBe('help')
    expect(template.filter((m) => m.role === 'help')).toHaveLength(1)
    expect(itemLabels(help).slice(0, 4)).toEqual(['Take the Tour…', '', 'Houston Guide', 'Report an Issue'])
  })

  it('carries only the tour and the links on macOS, where share and updates live in the app menu', () => {
    const help = appMenuTemplate(true).at(-1)!
    expect(itemLabels(help)).toEqual(['Take the Tour…', '', 'Houston Guide', 'Report an Issue'])
  })

  it.each([true, false])('Take the Tour… asks the renderer to replay the tips (isMac=%s)', (isMac) => {
    const help = appMenuTemplate(isMac).at(-1)!
    const item = (help.submenu as { label?: string; click?: () => void }[]).find(
      (i) => i.label === 'Take the Tour…'
    )!
    item.click!()
    expect(sentCommands.at(-1)).toEqual({ type: 'take-tour' })
  })

  it('links to https URLs that pass the external-open allowlist', () => {
    for (const url of [GUIDE_URL, ISSUES_URL]) {
      expect(url.startsWith('https://')).toBe(true)
      expect(isSafeExternalUrl(url)).toBe(true)
    }
  })
})

describe('File menu', () => {
  type Item = {
    label?: string
    role?: string
    type?: string
    accelerator?: string
    registerAccelerator?: boolean
    enabled?: boolean
    submenu?: Item[]
  }
  const fileMenu = (template: unknown[]): Item[] =>
    ((template as Item[]).find((m) => m.label === 'File')?.submenu ?? []) as Item[]
  const item = (items: Item[], label: string): Item => {
    const found = items.find((i) => i.label === label)
    expect(found, `missing "${label}"`).toBeDefined()
    return found!
  }
  const ctx = { recentWorkspaces: [] as string[], hasConversation: true }

  it('lists the chat items above Close on every platform', () => {
    for (const mac of [true, false]) {
      const labels = fileMenu(appMenuTemplate(mac, ctx)).map((i) => i.label ?? i.role ?? i.type)
      expect(labels.slice(0, 7)).toEqual([
        'New Chat',
        'New Chat in Another Folder…',
        'Open Recent',
        'separator',
        'Import Chat…',
        'Export Chat',
        'separator'
      ])
      expect(labels[7]).toBe('Close')
      expect(labels.includes('quit')).toBe(!mac)
    }
  })

  it('shows the new-chat shortcuts without registering them (the renderer owns the keys)', () => {
    const items = fileMenu(appMenuTemplate(true, ctx))
    expect(item(items, 'New Chat')).toMatchObject({
      accelerator: 'CmdOrCtrl+N',
      registerAccelerator: false
    })
    expect(item(items, 'New Chat in Another Folder…')).toMatchObject({
      accelerator: 'CmdOrCtrl+Shift+N',
      registerAccelerator: false
    })
    // ⌘W stays a real accelerator: main routes it (terminal tab vs window).
    expect(item(items, 'Close').registerAccelerator).toBeUndefined()
  })

  it('follows user keybinding overrides, and shows nothing for an unbound one', () => {
    const items = fileMenu(
      appMenuTemplate(true, {
        ...ctx,
        keybindings: { 'new-chat': 'mod+alt+j', 'new-chat-in-folder': null }
      })
    )
    expect(item(items, 'New Chat').accelerator).toBe('CmdOrCtrl+Alt+J')
    expect(item(items, 'New Chat in Another Folder…').accelerator).toBeUndefined()
  })

  it('greys out Export Chat when no chat is open', () => {
    expect(item(fileMenu(appMenuTemplate(true, ctx)), 'Export Chat').enabled).toBe(true)
    const none = fileMenu(appMenuTemplate(true, { ...ctx, hasConversation: false }))
    expect(item(none, 'Export Chat').enabled).toBe(false)
    expect(item(none, 'Export Chat').submenu!.map((i) => i.label)).toEqual([
      'As JSON…',
      'As HTML…'
    ])
  })

  it('lists recent folders under Open Recent, with a disabled placeholder when empty', () => {
    const empty = item(fileMenu(appMenuTemplate(true, ctx)), 'Open Recent').submenu!
    expect(empty).toEqual([{ label: 'No Recent Folders', enabled: false }])
    const recents = item(
      fileMenu(appMenuTemplate(true, { ...ctx, recentWorkspaces: ['/srv/a', '/srv/b'] })),
      'Open Recent'
    ).submenu!
    expect(recents.map((i) => i.label)).toEqual(['/srv/a', '/srv/b'])
  })
})

describe('bindingToAccelerator', () => {
  it('maps the renderer chord format to Electron accelerators', () => {
    expect(bindingToAccelerator('mod+n')).toBe('CmdOrCtrl+N')
    expect(bindingToAccelerator('mod+shift+n')).toBe('CmdOrCtrl+Shift+N')
    expect(bindingToAccelerator('ctrl+alt+Tab')).toBe('Ctrl+Alt+Tab')
    expect(bindingToAccelerator('mod+/')).toBe('CmdOrCtrl+/')
    expect(bindingToAccelerator('mod++')).toBe('CmdOrCtrl+Plus')
    expect(bindingToAccelerator('mod+ArrowUp')).toBe('CmdOrCtrl+Up')
    expect(bindingToAccelerator('F5')).toBe('F5')
  })

  it('returns undefined for unbound, modifier-only, or unrenderable bindings', () => {
    expect(bindingToAccelerator(null)).toBeUndefined()
    expect(bindingToAccelerator(undefined)).toBeUndefined()
    expect(bindingToAccelerator('')).toBeUndefined()
    expect(bindingToAccelerator('mod+shift+')).toBeUndefined()
    expect(bindingToAccelerator('mod+MediaPlayPause')).toBeUndefined()
  })
})

describe('recentFolderLabel', () => {
  it('shortens the home directory to ~', () => {
    expect(recentFolderLabel('/home/x/code/app', true, '/home/x')).toBe('~/code/app')
    expect(recentFolderLabel('/home/x', true, '/home/x')).toBe('~')
    // A sibling that merely shares the prefix is left alone.
    expect(recentFolderLabel('/home/xy/app', true, '/home/x')).toBe('/home/xy/app')
    // Windows paths use backslashes.
    expect(recentFolderLabel('C:\\Users\\x\\code', false, 'C:\\Users\\x')).toBe('~\\code')
    expect(recentFolderLabel('C:\\Users\\xy', false, 'C:\\Users\\x')).toBe('C:\\Users\\xy')
  })

  it('escapes & on Windows/Linux, where it marks a mnemonic', () => {
    expect(recentFolderLabel('/srv/R&D', false, '/home/x')).toBe('/srv/R&&D')
    expect(recentFolderLabel('/srv/R&D', true, '/home/x')).toBe('/srv/R&D')
  })
})
