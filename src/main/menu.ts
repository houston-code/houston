import { Menu, BrowserWindow, dialog } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { homedir } from 'os'
import { APP_NAME, IPC } from '@shared/constants'
import type { MenuCommand, MenuState } from '@shared/types'
import { checkForUpdatesFromMenu } from './updater'
import { shareHoustonFromMenu } from './share'
import { openExternalSafely } from './safeExternal'
import {
  getSettings,
  onSettingsSaved,
  pruneRecentWorkspaces,
  rememberWorkspace,
  workspaceExists
} from './store'

/**
 * The application menu. Houston previously relied on Electron's default menu,
 * whose File → "Close Window" (⌘W) always closed the whole window. We replace
 * that one item so ⌘W closes the active *terminal tab* when the integrated
 * terminal is focused (the behaviour every editor/terminal has), and only closes
 * the window otherwise. Every other entry keeps its standard role.
 *
 * On macOS the app submenu is built explicitly (rather than the `appMenu` role)
 * so it carries native "Settings…" (⌘,) and "Check for Updates…" items — the
 * former opens the in-app Settings modal over IPC, the latter runs the same feed
 * check as the in-Settings button. Both render on every macOS architecture; there
 * is no arch-specific gating.
 *
 * Every platform gets a Help menu (role 'help', always last) with Take the Tour…
 * (replays the getting-started tips, like the command palette entry), the product
 * guide, and an issue link. On macOS the role is what makes AppKit add its native
 * search field, which finds any menu item by name. Windows and Linux have no app
 * submenu, so "Check for Updates…" lives under Help there too, the platform
 * convention. Without it the only manual check on those platforms was buried in
 * Settings.
 *
 * "Share Houston…" sits beside it on every platform (see ./share): the share
 * sheet on macOS, copy-and-confirm on Windows/Linux.
 *
 * The File menu starts chats (in the current folder, a picked folder, or a recent
 * one) and imports/exports them. Those items only send a {@link MenuCommand} to the
 * renderer, which runs the same handlers as the command palette and sidebar. Their
 * shortcuts are display-only (`registerAccelerator: false`): the renderer's key
 * listener still owns ⌘N / ⇧⌘N, so a user's rebinding keeps working and the label
 * follows it. The menu is rebuilt when the recents, keybindings, or renderer state
 * it shows change.
 */

/** Whether the integrated terminal currently holds focus in the renderer. The
 * renderer reports this over IPC; the ⌘W handler reads it. */
let terminalFocused = false

export function setTerminalFocused(focused: boolean): void {
  terminalFocused = focused
}

export function isTerminalFocused(): boolean {
  return terminalFocused
}

/** Pure decision for ⌘W, split out so it can be unit-tested without Electron. */
export function resolveCloseAction(focused: boolean): 'close-tab' | 'close-window' {
  return focused ? 'close-tab' : 'close-window'
}

function onCloseShortcut(): void {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return
  if (resolveCloseAction(terminalFocused) === 'close-tab') {
    win.webContents.send(IPC.terminalCloseActive)
  } else {
    win.close()
  }
}

/** Renderer state the File menu reflects; reported over IPC as it changes. */
let menuState: MenuState = { hasConversation: false }

export function setMenuState(next: MenuState): void {
  const hasConversation = next?.hasConversation === true
  if (hasConversation === menuState.hasConversation) return
  menuState = { hasConversation }
  buildAppMenu()
}

function focusedOrFirstWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

function sendMenuCommand(cmd: MenuCommand): void {
  focusedOrFirstWindow()?.webContents.send(IPC.menuCommand, cmd)
}

/** File → Open Recent: start a new chat in a remembered folder, if it still exists. */
function onOpenRecent(path: string): void {
  if (!workspaceExists(path)) {
    pruneRecentWorkspaces() // the save rebuilds the menu without the dead entry
    const win = focusedOrFirstWindow()
    const opts = { type: 'warning' as const, message: 'That folder no longer exists.', detail: path }
    void (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts))
    return
  }
  rememberWorkspace(path) // moves it to the top of the list
  sendMenuCommand({ type: 'new-chat-in-workspace', workspace: path })
}

/** Default chords for the File-menu items that mirror renderer shortcuts (lib/shortcuts.ts). */
const MENU_SHORTCUT_DEFAULTS = {
  'new-chat': 'mod+n',
  'new-chat-in-folder': 'mod+shift+n'
} as const

const NAMED_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ' ': 'Space',
  '+': 'Plus'
}

/**
 * Convert a stored keybinding (`mod+shift+n`, the renderer's chord format) to an
 * Electron accelerator for display, or undefined when it's unbound or has a key
 * Electron can't render (the item then shows no shortcut rather than a wrong one).
 */
export function bindingToAccelerator(binding: string | null | undefined): string | undefined {
  if (!binding) return undefined
  let rest = binding.trim()
  const parts: string[] = []
  for (;;) {
    const m = /^(mod|ctrl|alt|shift)\+/i.exec(rest)
    if (!m) break
    const tok = m[1].toLowerCase()
    parts.push(
      tok === 'mod' ? 'CmdOrCtrl' : tok === 'ctrl' ? 'Ctrl' : tok === 'alt' ? 'Alt' : 'Shift'
    )
    rest = rest.slice(m[0].length)
  }
  if (!rest) return undefined
  let key: string | undefined
  if (rest in NAMED_KEYS) key = NAMED_KEYS[rest]
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(rest)) key = rest
  else if (rest.length === 1 && rest.trim()) key = rest.toUpperCase()
  return key ? [...parts, key].join('+') : undefined
}

/** The accelerator a File-menu item shows: the user's override, else the default. */
function menuAccelerator(
  id: keyof typeof MENU_SHORTCUT_DEFAULTS,
  keybindings: Record<string, string | null> | undefined
): string | undefined {
  const binding = keybindings && id in keybindings ? keybindings[id] : MENU_SHORTCUT_DEFAULTS[id]
  return bindingToAccelerator(binding)
}

/** A recent folder as a menu label: home shortened to `~`, `&` kept literal on Windows/Linux. */
export function recentFolderLabel(path: string, isMac: boolean, home = homedir()): string {
  const underHome =
    path === home || path.startsWith(home + '/') || path.startsWith(home + '\\')
  const short = home && underHome ? '~' + path.slice(home.length) : path
  // Windows/Linux read `&` as a mnemonic marker; `&&` renders one literal ampersand.
  return isMac ? short : short.replace(/&/g, '&&')
}

/** What the File menu shows beyond its fixed items. */
export interface FileMenuContext {
  recentWorkspaces: string[]
  hasConversation: boolean
  keybindings?: Record<string, string | null>
}

const EMPTY_FILE_MENU: FileMenuContext = { recentWorkspaces: [], hasConversation: false }

function fileMenu(isMac: boolean, ctx: FileMenuContext): MenuItemConstructorOptions {
  const recents: MenuItemConstructorOptions[] = ctx.recentWorkspaces.length
    ? ctx.recentWorkspaces.map((path) => ({
        label: recentFolderLabel(path, isMac),
        click: () => onOpenRecent(path)
      }))
    : [{ label: 'No Recent Folders', enabled: false }]
  return {
    label: 'File',
    submenu: [
      {
        label: 'New Chat',
        accelerator: menuAccelerator('new-chat', ctx.keybindings),
        registerAccelerator: false,
        click: () => sendMenuCommand({ type: 'new-chat' })
      },
      {
        label: 'New Chat in Another Folder…',
        accelerator: menuAccelerator('new-chat-in-folder', ctx.keybindings),
        registerAccelerator: false,
        click: () => sendMenuCommand({ type: 'new-chat-in-folder' })
      },
      { label: 'Open Recent', submenu: recents },
      { type: 'separator' },
      { label: 'Import Chat…', click: () => sendMenuCommand({ type: 'import-chat' }) },
      {
        label: 'Export Chat',
        enabled: ctx.hasConversation,
        submenu: [
          {
            label: 'As JSON…',
            click: () => sendMenuCommand({ type: 'export-chat', format: 'json' })
          },
          {
            label: 'As HTML…',
            click: () => sendMenuCommand({ type: 'export-chat', format: 'html' })
          }
        ]
      },
      { type: 'separator' },
      // Custom Close: terminal-tab-aware (see onCloseShortcut). Replaces the
      // default role:'close' / role:'quit' item that owned ⌘W.
      { label: 'Close', accelerator: 'CmdOrCtrl+W', click: onCloseShortcut },
      ...(isMac ? [] : [{ role: 'quit' as const }])
    ]
  }
}

/** Ask the renderer to open the Settings modal (native menu → in-app UI). */
function onOpenSettings(): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send(IPC.menuOpenSettings)
}

/**
 * The macOS app submenu, built by hand so it carries Settings… and Check for
 * Updates… alongside the standard roles. On macOS the first menu's label is always
 * the app name regardless of what we pass, but a label is required by the type.
 */
function macAppMenu(): MenuItemConstructorOptions {
  return {
    label: APP_NAME,
    submenu: [
      { role: 'about' },
      { label: 'Share Houston…', click: () => void shareHoustonFromMenu() },
      { type: 'separator' },
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: onOpenSettings },
      { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' }
    ]
  }
}

/** The product guide (docs/houston-guide.md) as published on the repo's main branch. */
export const GUIDE_URL = 'https://github.com/houston-code/houston/blob/main/docs/houston-guide.md'
export const ISSUES_URL = 'https://github.com/houston-code/houston/issues/new'

/** Help menu: the tour (same as the command palette's "Take the tour"), then the
 * guide and issue links. On Windows/Linux it also carries the manual update check
 * and sharing, which live in the app menu on macOS. */
function helpMenu(isMac: boolean): MenuItemConstructorOptions {
  return {
    role: 'help',
    submenu: [
      { label: 'Take the Tour…', click: () => sendMenuCommand({ type: 'take-tour' }) },
      { type: 'separator' },
      { label: 'Houston Guide', click: () => openExternalSafely(GUIDE_URL) },
      { label: 'Report an Issue', click: () => openExternalSafely(ISSUES_URL) },
      ...(isMac
        ? []
        : [
            { type: 'separator' as const },
            { label: 'Share Houston…', click: () => void shareHoustonFromMenu() },
            { label: 'Check for Updates…', click: () => void checkForUpdatesFromMenu() }
          ])
    ]
  }
}

/** The menu template for a platform. Split out so the per-platform layout is testable. */
export function appMenuTemplate(
  isMac: boolean,
  ctx: FileMenuContext = EMPTY_FILE_MENU
): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [macAppMenu()] : []),
    fileMenu(isMac, ctx),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { role: 'front' as const }]
          : [{ role: 'close' as const }])
      ]
    },
    helpMenu(isMac)
  ]
}

/** The recents and keybindings the menu last rendered, to skip no-op rebuilds. */
let renderedSettingsKey = ''

function menuSettingsKey(s: { recentWorkspaces: string[]; keybindings?: unknown }): string {
  return JSON.stringify([s.recentWorkspaces, s.keybindings ?? null])
}

let followingSettings = false

export function buildAppMenu(): void {
  if (!followingSettings) {
    followingSettings = true
    onSettingsSaved((s) => {
      if (menuSettingsKey(s) !== renderedSettingsKey) buildAppMenu()
    })
  }
  const settings = getSettings()
  renderedSettingsKey = menuSettingsKey(settings)
  const ctx: FileMenuContext = {
    recentWorkspaces: settings.recentWorkspaces,
    hasConversation: menuState.hasConversation,
    keybindings: settings.keybindings
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(appMenuTemplate(process.platform === 'darwin', ctx))
  )
}
