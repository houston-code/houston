import { beforeEach, describe, expect, it, vi } from 'vitest'

// Which window has focus, and the templates the menu was built from.
const h = vi.hoisted(() => ({
  focused: null as unknown,
  templates: [] as unknown[]
}))

vi.mock('electron', () => ({
  Menu: {
    setApplicationMenu: () => {},
    buildFromTemplate: (t: unknown) => {
      h.templates.push(t)
      return {}
    }
  },
  BrowserWindow: { getFocusedWindow: () => h.focused, getAllWindows: () => [] },
  dialog: {},
  app: { getVersion: () => '0.0.0-test', getName: () => 'Houston', getPath: () => '/tmp', on: () => {} },
  shell: {}
}))
vi.mock('./store', () => ({
  getSettings: () => ({ recentWorkspaces: [] }),
  onSettingsSaved: () => {},
  pruneRecentWorkspaces: () => {},
  rememberWorkspace: () => {},
  workspaceExists: () => true
}))

interface Item {
  label?: string
  enabled?: boolean
  submenu?: Item[]
}

/** A fake chat window whose renderer reports menu state. */
function fakeWindow(id: number) {
  const destroyed: Array<() => void> = []
  const webContents = {
    id,
    send: () => {},
    once: (_e: 'destroyed', fn: () => void) => {
      destroyed.push(fn)
    }
  }
  return {
    win: { id, webContents, isDestroyed: () => false },
    webContents,
    destroy: () => destroyed.forEach((fn) => fn()),
    listenerCount: () => destroyed.length
  }
}

/** The label + enabled state of a top-level menu's item in the last built menu. */
function lastItem(menuLabel: string, itemLabel: RegExp): Item | undefined {
  const template = h.templates.at(-1) as Item[]
  return template.find((m) => m.label === menuLabel)?.submenu?.find((i) => itemLabel.test(i.label ?? ''))
}

async function load(): Promise<typeof import('./menu')> {
  vi.resetModules()
  h.templates.length = 0
  h.focused = null
  return import('./menu')
}

describe('per-window menu state', () => {
  beforeEach(() => {
    h.templates.length = 0
  })

  it('shows the focused window\'s state, not the one that reported last', async () => {
    const m = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    h.focused = a.win
    m.buildAppMenu()
    // A has a chat and the terminal open; B has neither.
    m.setMenuState({ hasConversation: true, open: { terminal: true } }, a.webContents)
    m.setMenuState({ hasConversation: false }, b.webContents)
    // B reported last, but A has focus.
    expect(lastItem('File', /^Export Chat$/)?.enabled).toBe(true)
    expect(lastItem('View', /Terminal$/)?.label).toBe('Hide Terminal')

    // Switching focus to B rebuilds the menu from B's state.
    h.focused = b.win
    m.refreshMenuForFocus()
    expect(lastItem('File', /^Export Chat$/)?.enabled).toBe(false)
    expect(lastItem('View', /Terminal$/)?.label).toBe('Show Terminal')

    // And back.
    h.focused = a.win
    m.refreshMenuForFocus()
    expect(lastItem('View', /Terminal$/)?.label).toBe('Hide Terminal')
  })

  it('skips a rebuild when nothing the menu shows changed', async () => {
    const m = await load()
    const a = fakeWindow(1)
    const b = fakeWindow(2)
    h.focused = a.win
    m.buildAppMenu()
    m.setMenuState({ hasConversation: true }, a.webContents)
    const built = h.templates.length
    // An unfocused window's report doesn't touch the menu, nor does a repeat.
    m.setMenuState({ hasConversation: false }, b.webContents)
    m.setMenuState({ hasConversation: true }, a.webContents)
    m.refreshMenuForFocus()
    expect(h.templates.length).toBe(built)
  })

  it('does not build the menu before startup has', async () => {
    const m = await load()
    const a = fakeWindow(1)
    h.focused = a.win
    m.setMenuState({ hasConversation: true }, a.webContents)
    m.refreshMenuForFocus()
    expect(h.templates).toHaveLength(0)
  })

  it("drops a window's state when its renderer goes away", async () => {
    const m = await load()
    const a = fakeWindow(1)
    h.focused = a.win
    m.buildAppMenu()
    m.setMenuState({ hasConversation: true }, a.webContents)
    m.setMenuState({ hasConversation: true, open: { terminal: true } }, a.webContents)
    // One destroyed listener per renderer, however often it reports.
    expect(a.listenerCount()).toBe(1)
    a.destroy()
    expect(lastItem('File', /^Export Chat$/)?.enabled).toBe(false)
  })

  it("clears a closed window's state without reading the destroyed renderer", async () => {
    const m = await load()
    const a = fakeWindow(1)
    h.focused = a.win
    m.buildAppMenu()
    // Like Electron's WebContents: its properties throw once it is destroyed.
    let gone = false
    const sender = {
      get id(): number {
        if (gone) throw new Error('Object has been destroyed')
        return 1
      },
      once: a.webContents.once
    }
    m.setMenuState({ hasConversation: true }, sender)
    m.setTerminalFocused(true, sender)
    expect(lastItem('File', /^Export Chat$/)?.enabled).toBe(true)
    gone = true
    h.focused = null
    expect(() => a.destroy()).not.toThrow()
    expect(lastItem('File', /^Export Chat$/)?.enabled).toBe(false)
    expect(m.isTerminalFocused(1)).toBe(false)
  })
})

describe('Close (Cmd/Ctrl+W) across windows', () => {
  it("closes the focused window's terminal tab by that window's own focus report", async () => {
    const m = await load()
    const sent: string[] = []
    let closed = 0
    const winOf = (id: number) => ({
      id,
      webContents: { id, send: (ch: string) => sent.push(`${id}:${ch}`) },
      close: () => closed++,
      isDestroyed: () => false
    })
    const file = m.appMenuTemplate(false).find((x) => x.label === 'File')
    const close = (file?.submenu as Array<{ label?: string; click?: () => void }>).find((i) => i.label === 'Close')
    m.setTerminalFocused(true, { id: 1, once: () => {} })
    // Window 2's page reports its terminal blurred after window 1's report (a reload, or
    // a late blur from the window being left).
    m.setTerminalFocused(false, { id: 2, once: () => {} })
    h.focused = winOf(1)
    close?.click?.()
    expect(closed).toBe(0)
    expect(sent).toEqual(['1:terminal:closeActive'])
    h.focused = winOf(2)
    close?.click?.()
    expect(closed).toBe(1)
  })
})
