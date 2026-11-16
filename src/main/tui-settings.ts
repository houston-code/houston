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
      {
        cmd: '/login edit|remove <p>',
        does: "change a provider's address fields and headers, or remove it (/login forget-key <p> forgets its key)"
      },
      { cmd: '/model [id]', does: "this chat's model; --default for new chats too" },
      { cmd: '/model refresh [p]', does: "fetch a provider's model list again" },
      { cmd: '/model fallback [op]', does: "models to try when the chat's model can't serve a turn" },
      { cmd: '/reasoning [effort]', does: "this chat's thinking effort; --default for new chats too" },
      { cmd: '/settings set proxyUrl <url>', does: 'the HTTP proxy for model, MCP, and web search requests' },
      { cmd: '/scorecard', does: 'how each model has behaved across your chats' }
    ],
    desktopOnly: "curating a provider's model list by hand, and its small model"
  },
  agent: {
    label: 'Agent Behavior',
    words: ['agent behavior', 'behavior', 'behaviour', 'loop'],
    entries: [
      { cmd: '/settings get', does: 'every setting the terminal changes, with its value' },
      {
        cmd: '/settings set <key> <value>',
        does: 'turn limits, cost ceilings, compaction, verify on stop, reasoning, custom instructions'
      }
    ]
  },
  tools: {
    label: 'Tools',
    words: ['web search', 'lsp', 'language servers', 'format on save', 'diagnostics'],
    entries: [
      { cmd: '/settings set searchProvider <id>', does: 'the web search provider' },
      { cmd: '/settings search-key [provider]', does: "enter a web search provider's API key (hidden)" },
      { cmd: '/settings set lspEnabled on|off', does: 'language servers (also formatOnSave, diagnosticsOnSave)' },
      { cmd: '/doctor', does: 'which tools are available here, and why one is not' }
    ],
    desktopOnly: 'removing a web search key, editing language servers, and integrations'
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
      { cmd: '/mcp edit <n>', does: "change a server's command, arguments, folder, or URL" },
      { cmd: '/mcp tools|reconnect <n>', does: "list a server's tools, or restart its connection" },
      { cmd: '/mcp login|logout <n>', does: "sign in to a remote server, or forget its tokens" },
      { cmd: '/mcp search <query>', does: 'search the MCP Registry; /mcp add-from-registry <name> adds one' }
    ]
  },
  hooks: {
    label: 'Hooks',
    words: ['hook'],
    entries: [
      { cmd: '/hooks [add|edit|remove n]', does: "list your hooks and the project's, add one (guided), edit one, or remove one" }
    ]
  },
  schedules: {
    label: 'Scheduled Runs',
    words: ['scheduled runs', 'schedule', 'scheduled'],
    entries: [
      { cmd: '/schedule', does: 'list scheduled runs (also /schedules)' },
      { cmd: '/schedule add', does: 'add a scheduled run (guided)' },
      { cmd: '/schedule show|pause|resume|run|delete <n>', does: 'read one, pause or resume it, run it now, or delete it' }
    ]
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
    entries: [
      { cmd: '/add-dir [path]', does: 'let the agent work in another folder this session (alone: list them)' },
      { cmd: '/settings add|remove additionalRoots <path>', does: 'a folder the agent may use in every session' }
    ],
    desktopOnly: 'whether new chats start in a worktree'
  },
  general: {
    label: 'General',
    words: ['notifications', 'notify', 'preferences'],
    entries: [
      { cmd: '/notify [mode]', does: `bell and notification when a run needs you: ${NOTIFY_MODES.join(' | ')}` },
      { cmd: '/settings set desktopNotifications on|off', does: "the app's notifications (also appBadge, backgroundWake)" },
      { cmd: '/settings export|import <path>', does: 'save your preferences to a file, or load them (asks first)' },
      { cmd: '/settings reset', does: 'every preference back to its default (asks first)' }
    ]
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
      { cmd: '/permissions add …', does: 'add a rule: allow|ask|deny <tool> <pattern> [--exact]' },
      { cmd: '/trust [forget]', does: "this folder's project-config trust, or forget it to re-decide" },
      { cmd: '/trust list|forget <n>', does: 'every folder you trusted or refused, or clear one' },
      { cmd: '/settings set webReads ask|allow', does: 'whether reading a web page asks first' }
    ],
    desktopOnly: 'editing a rule in place, and sandbox egress (/permissions shows it)'
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
    ['Agent behavior and tools', ['agent', 'tools']],
    ['Permissions', ['permissions']],
    ['Extensions', ['mcp', 'hooks', 'memory', 'customize']],
    ['Scheduled runs', ['schedules']],
    ['Folders', ['workspace']],
    ['Preferences and notifications', ['general']],
    ['This terminal', ['appearance', 'keyboard']]
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
