import type { Painter } from './tui'
import { describeNotifyMode, NOTIFY_MODES, type NotifyMode } from './tui-notify'
import { stripControlChars } from './tui-wrap'

/**
 * `/settings` in the terminal: an overview of what this terminal can change and with
 * which command, and `/settings <page>` for one of the desktop's Settings pages,
 * answered with the terminal commands that cover it. Pure, so the text is testable.
 */

/** One line of the overview or a page: a command and what it does. */
interface Entry {
  cmd: string
  does: string
}

/** A desktop Settings page as the terminal sees it. */
interface PageGuide {
  /** The desktop's own name for the page. */
  label: string
  /** Other words someone might type for it (`keys`, `appearance`, ...). */
  words: string[]
  /** The terminal commands that edit what is on it. */
  entries: Entry[]
  /** What on the page only the desktop app edits, when something is left. */
  desktopOnly?: string
}

/**
 * The desktop's Settings pages, keyed by the id `/settings <page>` takes there
 * (`src/renderer/src/components/settings/pageIds.ts`), so the same word works in both.
 */
const PAGES: Readonly<Record<string, PageGuide>> = {
  models: {
    label: 'Providers & Models',
    words: ['providers', 'provider', 'keys', 'key', 'api keys', 'login', 'model', 'proxy'],
    entries: [
      { cmd: '/login', does: 'set or replace a provider API key, or add a host (also /providers)' },
      { cmd: '/model [id]', does: "this chat's model; --default for new chats too" },
      { cmd: '/reasoning [effort]', does: "this chat's thinking effort; --default for new chats too" }
    ],
    desktopOnly: 'removing a provider, editing its fields, curating its model list, the network proxy, and the scorecard'
  },
  agent: {
    label: 'Agent Behavior',
    words: ['agent behavior', 'behavior', 'behaviour', 'loop'],
    entries: [],
    desktopOnly: 'turn limits, cost ceiling, compaction, verify on stop, and custom instructions'
  },
  tools: {
    label: 'Tools',
    words: ['web search', 'lsp', 'language servers', 'format on save', 'diagnostics'],
    entries: [{ cmd: '/doctor', does: 'which tools are available here, and why one is not' }],
    desktopOnly: 'the web search provider and key, language servers, and format and diagnostics on save'
  },
  customize: {
    label: 'Customize',
    words: ['skills', 'agents', 'commands', 'instructions'],
    entries: [
      { cmd: '/skills', does: "list the skills; run one with /<skill-name>" },
      { cmd: '/agents', does: "list the workspace's custom agents" },
      { cmd: '/agent <name> <task>', does: 'hand a task to one of them' },
      { cmd: '/init', does: "write or improve this project's AGENTS.md" },
      { cmd: '#note', does: 'save a standing instruction to AGENTS.md' }
    ],
    desktopOnly: 'writing new skills, agents, and commands'
  },
  mcp: {
    label: 'MCP Servers',
    words: ['mcp servers', 'servers', 'server'],
    entries: [
      { cmd: '/mcp', does: 'list servers, their status and last error' },
      { cmd: '/mcp add [--url u]', does: 'add a stdio server (guided), or a remote one by URL' },
      { cmd: '/mcp enable|disable|remove <n>', does: 'switch one on or off, or remove it' },
      { cmd: '/mcp tools|reconnect <n>', does: "list a server's tools, or restart its connection" },
      { cmd: '/mcp login|logout <n>', does: "sign in to a remote server, or forget its tokens" },
      { cmd: '/mcp search <query>', does: 'search the MCP Registry; /mcp add-from-registry <name> adds one' }
    ],
    desktopOnly: "editing a server's fields"
  },
  hooks: {
    label: 'Hooks',
    words: ['hook'],
    entries: [{ cmd: '/hooks [add|remove n]', does: 'list hooks, add one (guided), or remove one' }],
    desktopOnly: "editing a hook in place and listing a project's own hooks"
  },
  schedules: {
    label: 'Scheduled Runs',
    words: ['scheduled runs', 'schedule', 'scheduled'],
    entries: [],
    desktopOnly: 'scheduled runs'
  },
  memory: {
    label: 'Memory',
    words: ['memories'],
    entries: [
      { cmd: '/memory', does: 'list saved memories' },
      { cmd: '/memory show|edit|pin|unpin|forget <n>', does: 'read, change, pin, or forget one' },
      { cmd: '/memory undo|on|off|folder', does: 'undo the last change, switch memory on or off, or show where it lives' }
    ]
  },
  import: {
    label: 'Import',
    words: [],
    entries: [],
    desktopOnly: 'importing configuration from other tools'
  },
  workspace: {
    label: 'Workspace',
    words: ['folders', 'additional folders', 'worktree'],
    entries: [{ cmd: '/add-dir [path]', does: 'let the agent work in another folder this session (alone: list them)' }],
    desktopOnly: 'additional folders kept for every session, and whether new chats start in a worktree'
  },
  general: {
    label: 'General',
    words: ['notifications', 'notify', 'preferences'],
    entries: [{ cmd: '/notify [mode]', does: `bell and notification when a run needs you: ${NOTIFY_MODES.join(' | ')}` }],
    desktopOnly: 'exporting, importing, or resetting your preferences'
  },
  appearance: {
    label: 'Appearance',
    words: ['theme', 'look'],
    entries: [
      { cmd: '/theme [name]', does: 'list or switch the terminal color theme' },
      { cmd: '/thoughts [mode]', does: 'how reasoning shows as it streams: show | summary | hide' },
      { cmd: '/verbose [on|off]', does: "show each tool's full output as it runs" },
      { cmd: '/screen-reader [on|off]', does: 'plain lines for screen readers, numbered choices' },
      { cmd: '/reduce-motion [on|off]', does: 'a still activity line instead of the spinner' }
    ]
  },
  keyboard: {
    label: 'Keyboard',
    words: ['shortcuts', 'keybindings', 'vim'],
    entries: [
      { cmd: '/vim [on|off]', does: 'vim keys in the composer' },
      { cmd: '/help', does: 'every key the terminal composer takes' }
    ],
    desktopOnly: 'rebinding keys'
  },
  permissions: {
    label: 'Permissions',
    words: ['permission', 'approval', 'rules', 'trust', 'sandbox'],
    entries: [
      { cmd: '/approval [mode]', does: "this chat's approval mode; --default for new chats too (Shift-Tab cycles it)" },
      { cmd: '/permissions [remove n]', does: 'list your saved permission rules, or remove one' },
      { cmd: '/trust [forget]', does: "this folder's project-config trust, or forget it to re-decide" }
    ],
    desktopOnly: 'adding or editing rules, trusted folders other than this one, and sandbox egress'
  },
  about: {
    label: 'About',
    words: ['version', 'diagnostics', 'doctor'],
    entries: [{ cmd: '/doctor', does: 'check your setup: model, sandbox, tools, MCP' }],
    desktopOnly: 'updates (`houston --version` prints the version)'
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/&/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * The page id a typed word names: its id, its desktop label, or one of its other
 * words, ignoring case and `&`. An id or label wins over another page's word, so
 * `keys` (Providers & Models) and `keyboard` never collide. Null when none.
 */
export function settingsPageFor(words: string): string | null {
  const w = norm(words)
  if (!w) return null
  for (const [id, page] of Object.entries(PAGES)) if (w === id || w === norm(page.label)) return id
  for (const [id, page] of Object.entries(PAGES)) if (page.words.includes(w)) return id
  return null
}

/** The desktop page ids, in the desktop's order. */
export const SETTINGS_PAGE_IDS: readonly string[] = Object.keys(PAGES)

function entryLines(entries: Entry[], paint: Painter): string[] {
  const width = Math.max(...entries.map((e) => e.cmd.length))
  return entries.map((e) => `    ${paint(e.cmd.padEnd(width), 'cyan')}  ${e.does}`)
}

/**
 * `/settings <page>`: what the terminal does for that desktop page. An unknown word
 * lists the pages instead.
 */
export function renderSettingsPage(words: string, paint: Painter): string {
  const id = settingsPageFor(words)
  if (!id) {
    return paint(
      `· no settings page "${stripControlChars(words.trim())}"; pages: ${SETTINGS_PAGE_IDS.join(', ')}`,
      'yellow'
    )
  }
  const page = PAGES[id]
  const lines = [paint(page.label, 'bold')]
  if (page.entries.length) lines.push(...entryLines(page.entries, paint))
  if (page.desktopOnly) {
    lines.push(
      paint(
        `  ${page.entries.length ? 'In the desktop app only' : 'Edited in the desktop app'}: ${page.desktopOnly}.`,
        'dim'
      )
    )
  }
  return lines.join('\n')
}

/** What the overview reports about this terminal right now. */
export interface TerminalLiveSettings {
  reduceMotion: boolean
  screenReader: boolean
  notifyMode: NotifyMode
}

/** Commands that reach any setting, listed ahead of the per-page groups. */
const ANY_SETTING: Entry[] = [
  { cmd: '/config [key[=value]]', does: 'pick and change a setting, or show or set one (/config --help lists them)' },
  { cmd: '/status', does: 'what this session runs on: model, approval, sandbox, network, settings sources' }
]

/**
 * `/settings` alone: where settings live, every command that changes one from the
 * terminal, grouped as the desktop's pages are, and this terminal's own switches.
 */
export function renderSettingsOverview(path: string, live: TerminalLiveSettings, paint: Painter): string {
  const groups: Array<[string, string[]]> = [
    ['Models and keys', ['models']],
    ['Permissions', ['permissions']],
    ['Extensions', ['mcp', 'hooks', 'memory', 'customize']],
    ['This session', ['workspace']],
    ['This terminal', ['appearance', 'keyboard', 'general']]
  ]
  const lines = [paint('Settings', 'bold'), `  file: ${stripControlChars(path)}`, '']
  lines.push('  Any setting:', ...entryLines(ANY_SETTING, paint))
  for (const [title, ids] of groups) {
    lines.push(`  ${title}:`)
    lines.push(...entryLines(ids.flatMap((id) => PAGES[id].entries), paint))
  }
  lines.push(
    '',
    '  Now:',
    `    notifications:  ${live.notifyMode}, ${describeNotifyMode(live.notifyMode)}`,
    `    screen reader:  ${live.screenReader ? 'on' : 'off'}`,
    `    reduced motion: ${live.reduceMotion || live.screenReader ? 'on' : 'off'}${
      live.screenReader && !live.reduceMotion ? ' (with screen-reader mode)' : ''
    }`,
    '',
    paint(`  /settings <page> shows what the terminal covers on a desktop page (${SETTINGS_PAGE_IDS.join(', ')}).`, 'dim'),
    paint('  Changes here apply on your next message, no restart needed.', 'dim')
  )
  return lines.join('\n')
}
