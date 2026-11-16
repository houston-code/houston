import { describe, expect, it } from 'vitest'
import { BUILTIN_COMMAND_CATALOG } from '@shared/commands'
import { renderSettingsOverview, renderSettingsPage, settingsPageFor, SETTINGS_PAGE_IDS } from './tui-settings'
import { parseSettingsAction, type Painter } from './tui'

const plain: Painter = (s) => s
const live = { reduceMotion: false, screenReader: false, notifyMode: 'auto' as const }

describe('settingsPageFor', () => {
  it("takes the desktop's page ids and labels, ignoring case and &", () => {
    expect(settingsPageFor('permissions')).toBe('permissions')
    expect(settingsPageFor('Agent Behavior')).toBe('agent')
    expect(settingsPageFor('providers & models')).toBe('models')
    expect(settingsPageFor('MCP')).toBe('mcp')
  })

  it('takes the other words people use for a page', () => {
    expect(settingsPageFor('keys')).toBe('models')
    expect(settingsPageFor('theme')).toBe('appearance')
    expect(settingsPageFor('notifications')).toBe('general')
    expect(settingsPageFor('vim')).toBe('keyboard')
  })

  it('is null for a word that names no page', () => {
    expect(settingsPageFor('')).toBeNull()
    expect(settingsPageFor('frobnicate')).toBeNull()
  })

  it("covers every desktop page, in the desktop's order", () => {
    expect(SETTINGS_PAGE_IDS).toEqual([
      'models', 'agent', 'tools', 'customize', 'mcp', 'hooks', 'schedules', 'memory', 'import',
      'workspace', 'general', 'appearance', 'keyboard', 'permissions', 'about'
    ])
  })
})

describe('renderSettingsPage', () => {
  it('names the terminal commands that cover the page', () => {
    const out = renderSettingsPage('permissions', plain)
    expect(out).toContain('Permissions')
    expect(out).toContain('/approval [mode]')
    expect(out).toContain('/permissions [remove n]')
    expect(out).toContain('/trust [forget]')
    expect(out).toContain('In the desktop app only')
  })

  it('says when a page is edited only in the desktop app', () => {
    // Agent Behavior is edited here with /settings set; Import still is not.
    expect(renderSettingsPage('import', plain)).toContain('Edited in the desktop app: importing configuration')
    expect(renderSettingsPage('agent', plain)).not.toContain('Edited in the desktop app')
  })

  it('lists the terminal commands a page has, and calls none of them desktop-only', () => {
    const schedules = renderSettingsPage('schedules', plain)
    expect(schedules).toContain('/schedule add')
    expect(schedules).toContain('/schedule show|pause|resume|run|delete <n>')
    expect(schedules).not.toContain('desktop app')
    const permissions = renderSettingsPage('permissions', plain)
    expect(permissions).toContain('/permissions add')
    expect(permissions).toContain('/trust list|forget <n>')
    expect(permissions).not.toMatch(/desktop app only: adding|trusted folders other than this one/)
    expect(renderSettingsPage('mcp', plain)).toContain('/mcp edit <n>')
    expect(renderSettingsPage('mcp', plain)).not.toContain('desktop app')
    expect(renderSettingsPage('hooks', plain)).toContain('/hooks [add|edit|remove n]')
    expect(renderSettingsPage('hooks', plain)).not.toContain('desktop app')
  })

  it('lists the pages for an unknown word, without its control characters', () => {
    const out = renderSettingsPage('nope\x1b[2J', plain)
    expect(out).toContain('no settings page "nope[2J"')
    expect(out).not.toContain('\x1b')
    expect(out).toContain('permissions')
  })
})

describe('renderSettingsOverview', () => {
  const out = renderSettingsOverview('/profile/settings.json', live, plain)

  it('shows the file, and that keys are set here with /login', () => {
    expect(out).toContain('file: /profile/settings.json')
    expect(out).toContain('/login')
    expect(out).toContain('API key')
    expect(out).not.toMatch(/desktop app has the full settings panel/)
  })

  it('lists every terminal command that changes a setting', () => {
    for (const cmd of [
      '/login', '/model', '/reasoning', '/approval', '/permissions', '/trust', '/mcp', '/hooks', '/memory',
      '/add-dir', '/theme', '/thoughts', '/verbose', '/screen-reader', '/reduce-motion', '/vim', '/notify',
      '/config', '/status', '/schedule', '/permissions add', '/trust list', '/mcp edit'
    ]) {
      expect(out, cmd).toContain(cmd)
    }
    expect(out).toContain('--default')
  })

  it("reports this terminal's switches", () => {
    expect(out).toContain('notifications:  auto')
    expect(out).toContain('screen reader:  off')
    const sr = renderSettingsOverview('/p', { ...live, screenReader: true }, plain)
    expect(sr).toContain('reduced motion: on (with screen-reader mode)')
  })
})

describe('the /mcp catalog description', () => {
  it('names every verb the terminal accepts', () => {
    const mcp = BUILTIN_COMMAND_CATALOG.find((c) => c.name === 'mcp')!
    const verbs = ['add', 'remove', 'enable', 'disable', 'reconnect', 'tools', 'login', 'logout']
    for (const v of verbs) {
      // The terminal takes it...
      expect(parseSettingsAction(v === 'add' ? 'add' : `${v} 1`).op, v).not.toBe('usage')
      // ...and the menu says so.
      expect(mcp.description, v).toContain(v)
    }
    expect(parseSettingsAction('search x').op).toBe('search')
    expect(mcp.description).toContain('search')
  })
})
