import { isReasoningEffort, type ReasoningEffort } from '@shared/agent'
import { parseApprovalPolicy, type ApprovalPolicy } from '@shared/types'
import { isRewindMode, type RewindMode } from '@shared/rewind'
import { parseLoopArgs } from '@shared/loopCommand'
import { pageForWords, type TabId } from '../components/settings/pageIds'
import type { Theme } from './theme'

/** The Settings page a command opens on. */
export type SettingsSection = TabId

/**
 * What the desktop app does for one of the built-in commands it shares with the
 * terminal. Pure, so the mapping is testable; App carries the action out.
 *
 * Each one lands on the desktop's own surface for the job (the Changes panel, the
 * model picker, Settings), so a command learned in the terminal does the same thing
 * here instead of being sent to the model as a message.
 */
export type DesktopCommandAction =
  /**
   * `query`: open on a settings search for these words. `ignored`: words the page
   * can't act on from here (a terminal verb like `/mcp enable 2`), said in a notice.
   */
  | { kind: 'settings'; section: SettingsSection; query?: string; ignored?: string }
  /** `asDefault` (`--default`): also make it what new chats start with. */
  | { kind: 'model'; query: string; asDefault?: boolean }
  /** `last`: show the diff of the edit that many back (`/changes last [n]`). */
  | { kind: 'changes'; last?: number }
  /**
   * `/rewind undo`, or `/rewind <n> [mode]` (`turn` is 0-based, oldest first, as the
   * rewind picker numbers it). Neither opens the picker. `invalid`: words naming neither.
   */
  | { kind: 'rewind'; undo?: boolean; turn?: number; mode?: RewindMode; invalid?: string }
  /** `/theme <name>`: switch the app theme; `invalid` is a name the app has no theme for. */
  | { kind: 'theme'; theme: Theme }
  | { kind: 'theme'; invalid: string }
  /** `/trust forget`: forget this folder's decision and ask again. */
  | { kind: 'trust-forget' }
  /** `/memory on|off`. */
  | { kind: 'memory-enable'; on: boolean }
  /** `/memory folder`: show the memory folder. */
  | { kind: 'memory-folder' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'retry' }
  /** Fork the chat: whole, or (`turn`, 0-based) from before that message. */
  | { kind: 'fork'; turn?: number }
  | { kind: 'resume'; query: string }
  | { kind: 'btw'; question: string }
  | { kind: 'btw-clear' }
  | { kind: 'cost' }
  | { kind: 'context' }
  | { kind: 'cwd' }
  | { kind: 'share' }
  /** No policy: report the current one. `invalid` is a word that named none. */
  | { kind: 'approval'; policy?: ApprovalPolicy; invalid?: string; asDefault?: boolean }
  | { kind: 'reasoning'; effort?: ReasoningEffort; invalid?: string; asDefault?: boolean }
  /** `/loop [interval] <prompt>`: schedule it, or say why not (`error`). */
  | { kind: 'loop'; spec: string; task: string }
  | { kind: 'loop-error'; error: string }

/**
 * Split `--default` off a command argument, anywhere in it, as the terminal does:
 * `/model`, `/reasoning` and `/approval` change the open chat, and with `--default`
 * they also set what new chats start with.
 */
export function splitDefaultFlag(arg: string): { rest: string; asDefault: boolean } {
  const words = arg.trim().split(/\s+/).filter(Boolean)
  const asDefault = words.includes('--default')
  return { rest: words.filter((w) => w !== '--default').join(' '), asDefault }
}

const THEME_WORDS: Record<string, Theme> = {
  system: 'system',
  auto: 'system',
  os: 'system',
  default: 'system',
  dark: 'dark',
  light: 'light'
}

/** The rewind modes by the words the terminal takes for them (a number is its place in the dialog). */
function rewindModeWord(word: string): RewindMode | null {
  const w = word.toLowerCase()
  if (w === 'chat') return 'conversation'
  if (isRewindMode(w)) return w
  const n = Number(w)
  const order: RewindMode[] = ['both', 'conversation', 'code']
  return Number.isInteger(n) && n >= 1 && n <= order.length ? order[n - 1] : null
}

function parseRewind(arg: string): DesktopCommandAction {
  const [first, second, ...more] = arg.split(/\s+/).filter(Boolean)
  if (!first) return { kind: 'rewind' }
  if (first.toLowerCase() === 'undo' && !second) return { kind: 'rewind', undo: true }
  const n = Number(first)
  if (!Number.isInteger(n) || n < 1 || more.length) return { kind: 'rewind', invalid: arg }
  if (!second) return { kind: 'rewind', turn: n - 1 }
  const mode = rewindModeWord(second)
  return mode ? { kind: 'rewind', turn: n - 1, mode } : { kind: 'rewind', invalid: arg }
}

/** `/memory`: the verbs the app can carry out itself; the rest open the page and say so. */
function parseMemory(arg: string): DesktopCommandAction {
  const verb = arg.split(/\s+/)[0]?.toLowerCase() ?? ''
  if (!verb || verb === 'list') return { kind: 'settings', section: 'memory' }
  if (verb === 'on' || verb === 'off') return { kind: 'memory-enable', on: verb === 'on' }
  if (verb === 'folder') return { kind: 'memory-folder' }
  return { kind: 'settings', section: 'memory', ignored: arg }
}

export function desktopCommandAction(name: string, args: string): DesktopCommandAction | null {
  const arg = args.trim()
  switch (name) {
    case 'settings': {
      // `/settings permissions` opens that page; any other words open a search.
      if (!arg) return { kind: 'settings', section: 'models' }
      const page = pageForWords(arg)
      return page ? { kind: 'settings', section: page } : { kind: 'settings', section: 'models', query: arg }
    }
    case 'login':
      return { kind: 'settings', section: 'models' }
    case 'mcp':
      // Servers are added, switched on and off, and signed in to on the page itself.
      return arg && arg.toLowerCase() !== 'list'
        ? { kind: 'settings', section: 'mcp', ignored: arg }
        : { kind: 'settings', section: 'mcp' }
    case 'hooks':
      return { kind: 'settings', section: 'hooks' }
    case 'memory':
      return parseMemory(arg)
    case 'trust':
      if (!arg) return { kind: 'settings', section: 'permissions' }
      if (arg.toLowerCase() === 'forget') return { kind: 'trust-forget' }
      return { kind: 'settings', section: 'permissions', ignored: arg }
    case 'theme': {
      if (!arg) return { kind: 'settings', section: 'appearance' }
      const theme = THEME_WORDS[arg.toLowerCase()]
      return theme ? { kind: 'theme', theme } : { kind: 'theme', invalid: arg }
    }
    case 'model': {
      // `/model fallback ...` edits the fallback list, which lives on the Models page.
      if (/^fallbacks?\b/i.test(arg)) return { kind: 'settings', section: 'models', query: 'fallback models' }
      const { rest, asDefault } = splitDefaultFlag(arg)
      return { kind: 'model', query: rest, ...(asDefault ? { asDefault } : {}) }
    }
    case 'changes': {
      const m = /^last(?:\s+(\d+))?$/i.exec(arg)
      return m ? { kind: 'changes', last: Math.max(1, Number(m[1] ?? 1) || 1) } : { kind: 'changes' }
    }
    case 'rewind':
      return parseRewind(arg)
    case 'undo':
      return { kind: 'undo' }
    case 'redo':
      return { kind: 'redo' }
    case 'retry':
      return { kind: 'retry' }
    case 'fork': {
      const n = Number(arg.trim())
      return arg.trim() && Number.isInteger(n) && n >= 1 ? { kind: 'fork', turn: n - 1 } : { kind: 'fork' }
    }
    case 'resume':
      return { kind: 'resume', query: arg }
    case 'btw':
      return arg.toLowerCase() === 'clear' ? { kind: 'btw-clear' } : { kind: 'btw', question: arg }
    case 'cost':
      return { kind: 'cost' }
    case 'context':
      return { kind: 'context' }
    case 'cwd':
      return { kind: 'cwd' }
    case 'share':
      return { kind: 'share' }
    case 'approval': {
      const { rest, asDefault } = splitDefaultFlag(arg)
      const flag = asDefault ? { asDefault } : {}
      if (!rest) return { kind: 'approval', ...flag }
      const policy = parseApprovalPolicy(rest)
      return policy ? { kind: 'approval', policy, ...flag } : { kind: 'approval', invalid: rest, ...flag }
    }
    case 'loop': {
      const parsed = parseLoopArgs(arg)
      return parsed.ok ? { kind: 'loop', spec: parsed.spec, task: parsed.task } : { kind: 'loop-error', error: parsed.error }
    }
    case 'reasoning': {
      const { rest, asDefault } = splitDefaultFlag(arg)
      const flag = asDefault ? { asDefault } : {}
      if (!rest) return { kind: 'reasoning', ...flag }
      const effort = rest.toLowerCase()
      return isReasoningEffort(effort)
        ? { kind: 'reasoning', effort, ...flag }
        : { kind: 'reasoning', invalid: rest, ...flag }
    }
    default:
      return null
  }
}
