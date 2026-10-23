import { Menu, BrowserWindow, dialog } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { homedir } from 'os'
import { APP_NAME, IPC } from '@shared/constants'
import type { MenuCommand, MenuPanel, MenuState } from '@shared/types'
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
 * one) and side chats, and imports/exports them. Edit is the platform's standard
 * Edit menu plus Find in Chat. View shows and hides the app's panels and opens the
 * command palette, above the standard reload/zoom/full-screen items. Go moves
 * between chats. These items only send a {@link MenuCommand} to the renderer, which
 * runs the same handlers as the command palette and sidebar. Their shortcuts are
 * display-only (`registerAccelerator: false`): the renderer's key listener still
 * owns them, so a user's rebinding keeps working and the label follows it. The
 * menu is rebuilt when the recents, keybindings, or renderer state it shows change
 * (a panel opening flips its View item between Show and Hide).
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

const MENU_PANELS: readonly MenuPanel[] = ['sidebar', 'terminal', 'tasks', 'preview', 'side-chat']

/** Renderer state the menus reflect; reported over IPC as it changes. */
let menuState: Required<MenuState> = normalizeMenuState(undefined)

/**
 * The reported state with every field a plain boolean. It arrives over IPC, so
 * anything that isn't `true` reads as false/closed rather than trusting its shape.
 */
export function normalizeMenuState(next: MenuState | undefined): Required<MenuState> {
  const open = Object.fromEntries(
    MENU_PANELS.map((p) => [p, next?.open?.[p] === true])
  ) as Record<MenuPanel, boolean>
  return {
    hasConversation: next?.hasConversation === true,
    hasWorkspace: next?.hasWorkspace === true,
    open
  }
}

export function setMenuState(next: MenuState): void {
  const normalized = normalizeMenuState(next)
  if (JSON.stringify(normalized) === JSON.stringify(menuState)) return
  menuState = normalized
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

/** Default chords for the menu items that mirror renderer shortcuts (lib/shortcuts.ts). */
const MENU_SHORTCUT_DEFAULTS = {
  'new-chat': 'mod+n',
  'new-chat-in-folder': 'mod+shift+n',
  'command-palette': 'mod+k',
  'toggle-sidebar': 'mod+b',
  'toggle-terminal': 'ctrl+`',
  'find-in-chat': 'mod+f',
  'switch-model': 'mod+shift+m',
  'next-chat': 'ctrl+Tab',
  'prev-chat': 'ctrl+shift+Tab',
  'show-help': 'mod+/'
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

/** The accelerator a menu item shows: the user's override, else the default. */
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

/** What the menus show beyond their fixed items: settings plus the renderer's state. */
export interface MenuContext extends MenuState {
  recentWorkspaces: string[]
  keybindings?: Record<string, string | null>
}

const EMPTY_MENU: MenuContext = { recentWorkspaces: [], hasConversation: false }

/** An item that mirrors a renderer shortcut: shows its chord, leaves the key to the renderer. */
function shortcutItem(
  label: string,
  id: keyof typeof MENU_SHORTCUT_DEFAULTS,
  ctx: MenuContext,
  cmd: MenuCommand,
  extra: MenuItemConstructorOptions = {}
): MenuItemConstructorOptions {
  return {
    label,
    accelerator: menuAccelerator(id, ctx.keybindings),
    registerAccelerator: false,
    click: () => sendMenuCommand(cmd),
    ...extra
  }
}

function fileMenu(isMac: boolean, ctx: MenuContext): MenuItemConstructorOptions {
  const recents: MenuItemConstructorOptions[] = ctx.recentWorkspaces.length
    ? ctx.recentWorkspaces.map((path) => ({
        label: recentFolderLabel(path, isMac),
        click: () => onOpenRecent(path)
      }))
    : [{ label: 'No Recent Folders', enabled: false }]
  return {
    label: 'File',
    submenu: [
      shortcutItem('New Chat', 'new-chat', ctx, { type: 'new-chat' }),
      shortcutItem('New Chat in Another Folder…', 'new-chat-in-folder', ctx, {
        type: 'new-chat-in-folder'
      }),
      // A side chat belongs to the open chat, so it needs one.
      {
        label: 'New Side Chat',
        enabled: ctx.hasConversation,
        click: () => sendMenuCommand({ type: 'new-side-chat' })
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

/**
 * The platform's standard Edit menu (what the `editMenu` role builds) with Find in
 * Chat added. macOS keeps Paste and Match Style and the Speech submenu, and adds
 * its own AutoFill, Dictation, and Emoji items to a menu titled Edit; Windows and
 * Linux set Select All apart, as their default does.
 */
function editMenu(isMac: boolean, ctx: MenuContext): MenuItemConstructorOptions {
  const find = shortcutItem('Find in Chat…', 'find-in-chat', ctx, { type: 'find-in-chat' })
  return {
    label: 'Edit',
    submenu: isMac
      ? [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          find,
          {
            label: 'Speech',
            submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }]
          }
        ]
      : [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' },
          { type: 'separator' },
          find
        ]
  }
}

/** "Show X" or "Hide X", by whether that panel is open now. */
function panelLabel(ctx: MenuContext, panel: MenuPanel, name: string): string {
  return `${ctx.open?.[panel] ? 'Hide' : 'Show'} ${name}`
}

function panelItem(
  ctx: MenuContext,
  panel: MenuPanel,
  name: string,
  shortcut?: keyof typeof MENU_SHORTCUT_DEFAULTS
): MenuItemConstructorOptions {
  const cmd: MenuCommand = { type: 'toggle-panel', panel }
  const label = panelLabel(ctx, panel, name)
  return shortcut
    ? shortcutItem(label, shortcut, ctx, cmd)
    : { label, click: () => sendMenuCommand(cmd) }
}

/**
 * View: the app's panels (each item reads Show or Hide by its state), then the
 * standard reload, zoom, and full-screen items the `viewMenu` role builds.
 */
function viewMenu(ctx: MenuContext): MenuItemConstructorOptions {
  return {
    label: 'View',
    submenu: [
      shortcutItem('Command Palette…', 'command-palette', ctx, { type: 'command-palette' }),
      panelItem(ctx, 'sidebar', 'Sidebar', 'toggle-sidebar'),
      { type: 'separator' },
      panelItem(ctx, 'terminal', 'Terminal', 'toggle-terminal'),
      panelItem(ctx, 'tasks', 'Background Tasks'),
      panelItem(ctx, 'preview', 'Preview'),
      { ...panelItem(ctx, 'side-chat', 'Side Chat'), enabled: ctx.hasConversation },
      // Changes and Files are dialogs over a folder, not panels: always "Show".
      {
        label: 'Show Changes',
        enabled: ctx.hasWorkspace === true,
        click: () => sendMenuCommand({ type: 'show-changes' })
      },
      {
        label: 'Show Files',
        enabled: ctx.hasWorkspace === true,
        click: () => sendMenuCommand({ type: 'show-files' })
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  }
}

/** Go: move between chats, find one, or switch the model. */
function goMenu(ctx: MenuContext): MenuItemConstructorOptions {
  return {
    label: 'Go',
    submenu: [
      shortcutItem('Previous Chat', 'prev-chat', ctx, { type: 'cycle-chat', delta: -1 }),
      shortcutItem('Next Chat', 'next-chat', ctx, { type: 'cycle-chat', delta: 1 }),
      { type: 'separator' },
      { label: 'Search Chats…', click: () => sendMenuCommand({ type: 'search-chats' }) },
      shortcutItem('Switch Model…', 'switch-model', ctx, { type: 'switch-model' })
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

/** The product guide (docs/houston-guide.md) as published on the website, built from the
 * latest release (website/tools/build-docs.mjs). */
export const GUIDE_URL = 'https://houstoncode.ai/docs/'
export const ISSUES_URL = 'https://github.com/houston-code/houston/issues/new'

/** Help menu: the shortcut list and the tour (same as the command palette's), then the
 * guide and issue links. On Windows/Linux it also carries the manual update check
 * and sharing, which live in the app menu on macOS. */
function helpMenu(isMac: boolean, ctx: MenuContext): MenuItemConstructorOptions {
  return {
    role: 'help',
    submenu: [
      shortcutItem('Keyboard Shortcuts', 'show-help', ctx, { type: 'show-shortcuts' }),
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
  ctx: MenuContext = EMPTY_MENU
): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [macAppMenu()] : []),
    fileMenu(isMac, ctx),
    editMenu(isMac, ctx),
    viewMenu(ctx),
    goMenu(ctx),
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
    helpMenu(isMac, ctx)
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
  const ctx: MenuContext = {
    ...menuState,
    recentWorkspaces: settings.recentWorkspaces,
    keybindings: settings.keybindings
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(appMenuTemplate(process.platform === 'darwin', ctx))
  )
}
