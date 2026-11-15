import { readFileSync, watch as fsWatch, mkdirSync, writeFileSync, existsSync, type FSWatcher } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import type { EditorKey } from './tui-keys'
import { stripControlChars } from './tui-wrap'

/**
 * User keybindings for the terminal client: `~/.houston/keybindings.json`.
 *
 * The file maps keys to actions per context:
 *
 *     {
 *       "composer": { "ctrl-t": "transcript", "ctrl-x ctrl-k": "kill-line",
 *                     "ctrl-g": null, "alt-r": "command:review" },
 *       "picker": { "ctrl-n": "down", "ctrl-p": "up" },
 *       "transcript": { "d": "page-down", "u": "page-up" }
 *     }
 *
 * A key is a name (`ctrl-k`, `alt-b`, `shift-tab`, `f5`, `pageup`, or in the
 * transcript viewer a plain character); several separated by spaces are a chord,
 * pressed one after the other within `CHORD_TIMEOUT_MS`. `null` takes the key away,
 * and `command:<name>` sends that slash command from the composer.
 *
 * Without the file (or with nothing in a context) that context reads keys exactly
 * as it always has: the keybinding layer is not even in the path. A bad entry is
 * reported and skipped; it never stops the client starting.
 */

export type BindingContext = 'composer' | 'picker' | 'transcript'
export const BINDING_CONTEXTS: readonly BindingContext[] = ['composer', 'picker', 'transcript']

export type BindingAction =
  | { kind: 'action'; name: string }
  | { kind: 'command'; name: string }
  /** `null` in the file: the key does nothing here. */
  | { kind: 'unbind' }

/** The keys a context answers to, each chord's names joined by spaces. */
export type ContextBindings = ReadonlyMap<string, BindingAction>

export interface KeyBindings {
  composer: ContextBindings
  picker: ContextBindings
  transcript: ContextBindings
}

export const EMPTY_BINDINGS: KeyBindings = { composer: new Map(), picker: new Map(), transcript: new Map() }

/** How long a chord waits for its next key before the keys so far count on their own. */
export const CHORD_TIMEOUT_MS = 1000

/** Longest chord accepted. Real chords are two keys; four leaves room without inviting abuse. */
const MAX_CHORD = 4
/** Most entries read per context. */
const MAX_ENTRIES = 200
/** Largest file read. A keybindings file is a few lines. */
export const MAX_FILE_BYTES = 256 * 1024

/** Composer actions, each the editor key it stands for. */
export const COMPOSER_ACTIONS: Readonly<Record<string, EditorKey>> = {
  submit: { type: 'enter' },
  newline: { type: 'newline' },
  backspace: { type: 'backspace' },
  delete: { type: 'delete' },
  left: { type: 'left' },
  right: { type: 'right' },
  up: { type: 'up' },
  down: { type: 'down' },
  home: { type: 'home' },
  end: { type: 'end' },
  'word-left': { type: 'word-left' },
  'word-right': { type: 'word-right' },
  'kill-line': { type: 'kill-line' },
  'kill-to-start': { type: 'kill-to-start' },
  'kill-word': { type: 'kill-word' },
  yank: { type: 'yank' },
  'clear-screen': { type: 'clear-screen' },
  'history-search': { type: 'search' },
  complete: { type: 'tab' },
  interrupt: { type: 'interrupt' },
  eof: { type: 'eof' },
  escape: { type: 'escape' },
  'external-edit': { type: 'external-edit' },
  undo: { type: 'undo' },
  redo: { type: 'redo' },
  stash: { type: 'stash' },
  'paste-image': { type: 'paste-image' },
  suspend: { type: 'suspend' },
  'cycle-mode': { type: 'cycle-mode' },
  transcript: { type: 'transcript' },
  'cycle-thoughts': { type: 'cycle-thoughts' },
  'expand-paste': { type: 'expand-paste' }
}

/** Composer actions that are not an editor key: handled by the composer itself. */
export const COMPOSER_EXTRA_ACTIONS = ['shortcuts'] as const

/** Picker actions, as the readline keypress each stands for. */
export const PICKER_ACTIONS: Readonly<Record<string, { name: string; sequence?: string }>> = {
  up: { name: 'up' },
  down: { name: 'down' },
  select: { name: 'return', sequence: '\r' },
  toggle: { name: 'space', sequence: ' ' },
  cancel: { name: 'escape', sequence: '\x1b' }
}

/** Transcript viewer actions, as the key the viewer already answers to. */
export const TRANSCRIPT_ACTIONS: Readonly<Record<string, EditorKey>> = {
  'scroll-up': { type: 'up' },
  'scroll-down': { type: 'down' },
  'page-up': { type: 'page-up' },
  'page-down': { type: 'page-down' },
  top: { type: 'home' },
  bottom: { type: 'end' },
  search: { type: 'char', value: '/' },
  'next-match': { type: 'char', value: 'n' },
  'prev-match': { type: 'char', value: 'N' },
  'prev-message': { type: 'char', value: '{' },
  'next-message': { type: 'char', value: '}' },
  editor: { type: 'char', value: 'v' },
  close: { type: 'escape' }
}

export function actionNames(ctx: BindingContext): string[] {
  if (ctx === 'composer') return [...Object.keys(COMPOSER_ACTIONS), ...COMPOSER_EXTRA_ACTIONS]
  return Object.keys(ctx === 'picker' ? PICKER_ACTIONS : TRANSCRIPT_ACTIONS)
}

/** Every chord built in, which a user binding can replace or take away (`null`). */
export const DEFAULT_CHORDS: Readonly<Record<BindingContext, Readonly<Record<string, string>>>> = {
  composer: { 'ctrl-x ctrl-e': 'external-edit' },
  picker: {},
  transcript: {}
}

const SPECIAL_KEYS: Readonly<Record<string, string>> = {
  enter: 'enter', return: 'enter', ret: 'enter', cr: 'enter',
  esc: 'escape', escape: 'escape',
  tab: 'tab',
  space: 'space', spc: 'space',
  backspace: 'backspace', bs: 'backspace', bksp: 'backspace',
  delete: 'delete', del: 'delete',
  up: 'up', down: 'down', left: 'left', right: 'right',
  home: 'home', end: 'end',
  pageup: 'pageup', pgup: 'pageup', 'page-up': 'pageup',
  pagedown: 'pagedown', pgdn: 'pagedown', 'page-down': 'pagedown'
}

const NAVIGATION = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'delete'])

/** Ctrl with a punctuation key, as the byte a terminal sends for it. */
const CTRL_PUNCT: Readonly<Record<string, string>> = {
  '/': 'ctrl-_', _: 'ctrl-_', '-': 'ctrl-_', '6': 'ctrl-^', '^': 'ctrl-^', '\\': 'ctrl-\\', ']': 'ctrl-]',
  '@': 'ctrl-space', '2': 'ctrl-space', '[': 'escape'
}

/**
 * A key spelled in the file as the canonical name the decoder reports, or null when
 * it is not a key a terminal can send. Accepts `ctrl-`, `control-`, `C-`, `alt-`,
 * `meta-`, `option-`, `M-`, `shift-` (or `+` between them), in any order and case.
 */
export function normalizeKeyName(raw: string): string | null {
  let rest = raw.trim()
  if (!rest) return null
  let ctrl = false
  let alt = false
  let shift = false
  for (;;) {
    const m = /^(ctrl|control|c|alt|meta|option|opt|m|shift|s)[-+](?=.)/i.exec(rest)
    if (!m) break
    const mod = m[1].toLowerCase()
    if (mod === 'ctrl' || mod === 'control' || mod === 'c') ctrl = true
    else if (mod === 'shift' || mod === 's') shift = true
    else alt = true
    rest = rest.slice(m[0].length)
  }
  const special = SPECIAL_KEYS[rest.toLowerCase()]
  const fkey = /^f([1-9]|1[0-2])$/i.exec(rest)
  if (!special && !fkey && [...rest].length !== 1) return null

  if (fkey) return ctrl || alt || shift ? null : `f${fkey[1]}`
  if (special) {
    if (special === 'space') {
      if (ctrl && !alt && !shift) return 'ctrl-space'
      if (alt && !ctrl && !shift) return 'alt-space'
      return ctrl || alt || shift ? null : 'space'
    }
    if (special === 'tab') {
      if (ctrl || alt) return null
      return shift ? 'shift-tab' : 'tab'
    }
    if (special === 'enter') {
      const n = Number(ctrl) + Number(alt) + Number(shift)
      if (n > 1) return null
      return ctrl ? 'ctrl-enter' : alt ? 'alt-enter' : shift ? 'shift-enter' : 'enter'
    }
    if (special === 'escape') return ctrl || alt || shift ? null : 'escape'
    if (special === 'backspace') {
      if (ctrl || shift) return null
      return alt ? 'alt-backspace' : 'backspace'
    }
    if (NAVIGATION.has(special)) {
      const n = Number(ctrl) + Number(alt) + Number(shift)
      if (n > 1) return null
      return (ctrl ? 'ctrl-' : alt ? 'alt-' : shift ? 'shift-' : '') + special
    }
    return null
  }

  // A single character.
  const ch = rest
  const code = ch.codePointAt(0) ?? 0
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null
  if (ctrl) {
    // A terminal can't tell Ctrl-Shift-x from Ctrl-x, or Ctrl-Alt-x from Alt-Ctrl-x reliably.
    if (alt || shift) return null
    const lower = ch.toLowerCase()
    if (/^[a-z]$/.test(lower)) {
      // These four are the same bytes as keys that have names of their own.
      if (lower === 'i') return 'tab'
      if (lower === 'm') return 'enter'
      if (lower === 'h') return 'backspace'
      return `ctrl-${lower}`
    }
    return CTRL_PUNCT[ch] ?? null
  }
  const shifted = shift ? (ch.toUpperCase() !== ch ? ch.toUpperCase() : null) : ch
  if (shifted === null) return null
  return alt ? `alt-${shifted}` : shifted
}

/** True for a name that is a plain character (which types text in the composer and pickers). */
export function isPrintableName(name: string): boolean {
  return name === 'space' || [...name].length === 1
}

/** The name of a typed character: itself, except the space bar, which chords split on. */
export function charName(ch: string): string {
  return ch === ' ' ? 'space' : ch
}

/** A chord spelled in the file (`"ctrl-x ctrl-e"`), as canonical names, or null. */
export function parseChord(raw: string): string[] | null {
  // "space" can't be split on, so a lone space key is spelled `space`.
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (!parts.length || parts.length > MAX_CHORD) return null
  const names: string[] = []
  for (const p of parts) {
    const n = normalizeKeyName(p)
    if (n === null) return null
    names.push(n)
  }
  return names
}

/**
 * The file's text without comments (`//` to the end of a line, and block comments),
 * so the template can explain itself. Strings are left alone, so `"//"` survives.
 */
export function stripJsonComments(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 2
      continue
    }
    out += ch
    i++
  }
  // A trailing comma before } or ] is what a hand-edited file most often has.
  return out.replace(/,(\s*[}\]])/g, '$1')
}

/** A file-supplied string, safe to print and short enough for one line. */
function shown(s: string): string {
  const clean = stripControlChars(s)
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean
}

const COMMAND_RE = /^[a-z0-9][a-z0-9_:.-]{0,63}$/i

/**
 * Parse a keybindings file. Never throws: what is wrong is reported, one line per
 * problem, and the rest still applies.
 */
export function parseKeybindings(text: string): { bindings: KeyBindings; problems: string[] } {
  const problems: string[] = []
  const empty = (): { bindings: KeyBindings; problems: string[] } => ({ bindings: EMPTY_BINDINGS, problems })
  if (text.length > MAX_FILE_BYTES) {
    problems.push(`the file is larger than ${MAX_FILE_BYTES / 1024} KB; it was not read`)
    return empty()
  }
  let data: unknown
  try {
    data = JSON.parse(stripJsonComments(text).trim() || '{}')
  } catch (e) {
    problems.push(`not valid JSON (${shown(e instanceof Error ? e.message : String(e))})`)
    return empty()
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    problems.push('expected an object with "composer", "picker" or "transcript" in it')
    return empty()
  }
  const out: Record<BindingContext, Map<string, BindingAction>> = {
    composer: new Map(),
    picker: new Map(),
    transcript: new Map()
  }
  for (const [ctxName, entries] of Object.entries(data as Record<string, unknown>)) {
    if (ctxName.startsWith('$') || ctxName.startsWith('//')) continue
    if (!(BINDING_CONTEXTS as readonly string[]).includes(ctxName)) {
      problems.push(`"${shown(ctxName)}" is not a context (use composer, picker or transcript)`)
      continue
    }
    const ctx = ctxName as BindingContext
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      problems.push(`${ctx}: expected an object of "key": "action" entries`)
      continue
    }
    const list = Object.entries(entries as Record<string, unknown>)
    if (list.length > MAX_ENTRIES) problems.push(`${ctx}: only the first ${MAX_ENTRIES} entries are read`)
    const names = actionNames(ctx)
    for (const [rawKey, value] of list.slice(0, MAX_ENTRIES)) {
      const where = `${ctx}: "${shown(rawKey)}"`
      const chord = parseChord(rawKey)
      if (!chord) {
        problems.push(`${where} is not a key the terminal can send`)
        continue
      }
      if (ctx !== 'transcript' && isPrintableName(chord[0])) {
        problems.push(`${where} would stop you typing that character; use a key with ctrl or alt`)
        continue
      }
      let action: BindingAction
      if (value === null) action = { kind: 'unbind' }
      else if (typeof value !== 'string') {
        problems.push(`${where}: the action must be a string, or null to unbind the key`)
        continue
      } else if (value.startsWith('command:')) {
        const name = value.slice('command:'.length).replace(/^\//, '')
        if (ctx !== 'composer') {
          problems.push(`${where}: a command can only be bound in the composer`)
          continue
        }
        if (!COMMAND_RE.test(name)) {
          problems.push(`${where}: "${shown(value)}" is not a command name`)
          continue
        }
        action = { kind: 'command', name }
      } else if (names.includes(value)) action = { kind: 'action', name: value }
      else {
        problems.push(`${where}: unknown action "${shown(value)}" (see /keybindings for the list)`)
        continue
      }
      out[ctx].set(chord.join(' '), action)
    }
  }
  return { bindings: out, problems }
}

/** True when the user bound anything in this context (and so the layer is needed). */
export function hasBindings(b: KeyBindings, ctx: BindingContext): boolean {
  return b[ctx].size > 0
}

/** A context's bindings resolved for lookup: the built-in chords, then the user's. */
export interface ChordTable {
  bindings: ReadonlyMap<string, BindingAction>
  /** Every proper prefix of a chord, so a key can be held while a chord may follow. */
  prefixes: ReadonlySet<string>
}

export function chordTable(b: KeyBindings, ctx: BindingContext): ChordTable {
  const bindings = new Map<string, BindingAction>()
  for (const [k, v] of Object.entries(DEFAULT_CHORDS[ctx])) bindings.set(k, { kind: 'action', name: v })
  for (const [k, v] of b[ctx]) bindings.set(k, v)
  const prefixes = new Set<string>()
  for (const [k, v] of bindings) {
    if (v.kind === 'unbind') continue
    const parts = k.split(' ')
    for (let n = 1; n < parts.length; n++) prefixes.add(parts.slice(0, n).join(' '))
  }
  return { bindings, prefixes }
}

/** A key held while a chord may still follow. */
export interface Held<T> {
  name: string
  value: T
}

/** What the chord layer makes of input: a key passed on as it was, or a binding that fired. */
export type ChordOut<T> = { kind: 'pass'; value: T } | { kind: 'bound'; action: BindingAction; keys: string }

/**
 * The longest run of `held` from its start that is bound, as output, then the rest
 * fed again from an empty state. Used when a chord can't complete: on a key that
 * doesn't continue it, or when its time runs out (`final`).
 */
function settle<T>(t: ChordTable, held: Held<T>[], final: boolean): { held: Held<T>[]; out: ChordOut<T>[] } {
  const out: ChordOut<T>[] = []
  let n = held.length
  let action: BindingAction | undefined
  for (; n > 0; n--) {
    action = t.bindings.get(held.slice(0, n).map((h) => h.name).join(' '))
    if (action) break
  }
  if (action) out.push({ kind: 'bound', action, keys: held.slice(0, n).map((h) => h.name).join(' ') })
  else {
    out.push({ kind: 'pass', value: held[0].value })
    n = 1
  }
  let rest: Held<T>[] = []
  for (const h of held.slice(n)) {
    const r = feedChord(t, rest, h)
    rest = r.held
    out.push(...r.out)
  }
  if (final && rest.length) out.push(...settle(t, rest, true).out)
  return { held: final ? [] : rest, out }
}

/**
 * Feed one key to the chord layer. A key with no name (text, a paste) ends any
 * chord in progress and passes; a key that starts or continues a chord is held;
 * a completed binding fires; anything else passes as it came.
 */
export function feedChord<T>(
  t: ChordTable,
  held: Held<T>[],
  item: { name: string | null; value: T }
): { held: Held<T>[]; out: ChordOut<T>[] } {
  if (item.name === null) {
    const out = held.length ? settle(t, held, true).out : []
    return { held: [], out: [...out, { kind: 'pass', value: item.value }] }
  }
  const seq = [...held.map((h) => h.name), item.name].join(' ')
  const next = [...held, { name: item.name, value: item.value }]
  if (t.prefixes.has(seq)) return { held: next, out: [] }
  const action = t.bindings.get(seq)
  if (action) return { held: [], out: [{ kind: 'bound', action, keys: seq }] }
  if (!held.length) return { held: [], out: [{ kind: 'pass', value: item.value }] }
  return settle(t, next, false)
}

/** A chord's time ran out: what was held counts as the keys it was. */
export function flushChord<T>(t: ChordTable, held: Held<T>[]): ChordOut<T>[] {
  return held.length ? settle(t, held, true).out : []
}

/** A readline keypress (the pickers read those) as a keybinding name. */
export function keypressName(key: {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}): string | null {
  const name = key.name
  if (name === 'return') return key.meta ? 'alt-enter' : 'enter'
  if (name === 'enter') return 'ctrl-j'
  if (name === 'tab') return key.shift ? 'shift-tab' : 'tab'
  if (name === 'escape') return key.meta ? null : 'escape'
  if (name === 'backspace') return key.meta ? 'alt-backspace' : 'backspace'
  if (name === 'space') return key.ctrl ? 'ctrl-space' : key.meta ? 'alt-space' : 'space'
  if (name && (NAVIGATION.has(name) || /^f([1-9]|1[0-2])$/.test(name))) {
    if (/^f/.test(name)) return key.ctrl || key.meta || key.shift ? null : name
    const pre = key.ctrl ? 'ctrl-' : key.meta ? 'alt-' : key.shift ? 'shift-' : ''
    return pre + name
  }
  if (key.ctrl && name && /^[a-z]$/.test(name)) return `ctrl-${name}`
  const seq = key.sequence ?? ''
  if (key.meta && seq.length === 2 && seq[0] === '\x1b' && seq[1] >= ' ') return `alt-${charName(seq[1])}`
  if (!key.ctrl && !key.meta && [...seq].length === 1 && seq >= ' ' && seq !== '\x7f') return charName(seq)
  return null
}

/** How a binding reads in the shortcut overlay and /keybindings. */
export function describeAction(a: BindingAction): string {
  if (a.kind === 'unbind') return 'unbound'
  if (a.kind === 'command') return `/${a.name}`
  return a.name
}

/** A canonical key name as people write it: `Ctrl-X Ctrl-E`, `Alt-B`, `PageUp`. */
export function prettyKeys(keys: string): string {
  return keys
    .split(' ')
    .map((k) => {
      if (k === 'space') return 'Space'
      if (isPrintableName(k)) return k
      const ctrl = k.startsWith('ctrl-')
      return k
        .split(/-(?=.)/)
        .map((p) => {
          // Ctrl-x is written Ctrl-X; Alt keeps the case, since Alt-x and Alt-X differ.
          if (p.length === 1) return ctrl && /[a-z]/.test(p) ? p.toUpperCase() : p
          if (p === 'pageup') return 'PageUp'
          if (p === 'pagedown') return 'PageDown'
          if (/^f\d+$/.test(p)) return p.toUpperCase()
          return p[0].toUpperCase() + p.slice(1)
        })
        .join('-')
    })
    .join(' ')
}

/** The user's bindings as lines for the shortcut overlay, per context. Empty with none. */
export function describeBindings(b: KeyBindings): string[] {
  const lines: string[] = []
  for (const ctx of BINDING_CONTEXTS) {
    if (!b[ctx].size) continue
    lines.push(`  ${ctx}:`)
    for (const [keys, action] of b[ctx]) lines.push(`    ${prettyKeys(keys).padEnd(18)} ${describeAction(action)}`)
  }
  return lines
}

/** Where the file lives. */
export function keybindingsPath(home: string): string {
  return join(home, '.houston', 'keybindings.json')
}

/** What `/keybindings` writes when there is no file yet: everything commented out. */
export function keybindingsTemplate(): string {
  const list = (ctx: BindingContext): string => {
    const names = actionNames(ctx)
    const rows: string[] = []
    for (let i = 0; i < names.length; i += 6) rows.push(`//   ${names.slice(i, i + 6).join(', ')}`)
    return rows.join('\n')
  }
  return `// Houston terminal keybindings. Lines starting with // are comments.
//
// Each context maps a key to an action. A key is a name like ctrl-k, alt-b,
// shift-tab, f5, pageup or enter; several keys separated by spaces are a chord,
// pressed one after another ("ctrl-x ctrl-k"). null takes a key away, and
// "command:<name>" sends that slash command from the composer (the draft you were
// writing is stashed: Ctrl-S brings it back).
//
// Houston reads this file at startup and again whenever it changes. Mistakes are
// reported and skipped, never fatal. Press ? on an empty prompt to see your keys.
//
// Composer actions:
${list('composer')}
// Picker actions:
${list('picker')}
// Transcript viewer actions (plain characters can be bound here too):
${list('transcript')}
{
  "composer": {
    // "ctrl-t": "transcript",
    // "ctrl-x ctrl-k": "kill-line",
    // "alt-r": "command:review",
    // "ctrl-g": null
  },
  "picker": {
    // "ctrl-j": "down",
    // "ctrl-k": "up"
  },
  "transcript": {
    // "d": "page-down",
    // "u": "page-up"
  }
}
`
}

/** Create the file with the commented template if it is missing. Returns the path. */
export function ensureKeybindingsFile(path: string): { created: boolean } {
  if (existsSync(path)) return { created: false }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // `wx`: never overwrite a file that appeared in the meantime.
  try {
    writeFileSync(path, keybindingsTemplate(), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { created: false }
    throw e
  }
  return { created: true }
}

export interface KeybindingStore {
  /** The bindings in force now. */
  get: () => KeyBindings
  /** What the last read found wrong, each a line. */
  problems: () => string[]
  /** Read the file again; reports its problems if they differ from the last read's. */
  reload: () => void
  /** Stop watching the file. */
  close: () => void
}

/**
 * The live bindings: read once at startup, again whenever the file changes (or on
 * `reload`). Problems are reported through `report`, once per distinct set, so a
 * file saved twice with the same mistake doesn't say it twice.
 */
export function createKeybindingStore(opts: {
  path: string
  report: (problems: string[]) => void
  /** Injected for tests; defaults to the filesystem. */
  read?: (path: string) => string | null
  watch?: (dir: string, onChange: (file: string | null) => void) => (() => void) | null
}): KeybindingStore {
  const read =
    opts.read ??
    ((p: string): string | null => {
      try {
        return readFileSync(p, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    })
  let current: KeyBindings = EMPTY_BINDINGS
  let currentProblems: string[] = []
  let lastReport = ''
  const reload = (): void => {
    let problems: string[] = []
    try {
      const text = read(opts.path)
      if (text === null) current = EMPTY_BINDINGS
      else {
        const parsed = parseKeybindings(text)
        current = parsed.bindings
        problems = parsed.problems
      }
    } catch (e) {
      current = EMPTY_BINDINGS
      problems = [`could not be read (${shown((e as NodeJS.ErrnoException).code ?? String(e))})`]
    }
    currentProblems = problems
    const key = problems.join('\n')
    if (key !== lastReport) {
      lastReport = key
      if (problems.length) opts.report(problems)
    }
  }
  reload()
  const file = basename(opts.path)
  const watch =
    opts.watch ??
    ((dir: string, onChange: (file: string | null) => void): (() => void) | null => {
      let w: FSWatcher
      try {
        // The directory, not the file: the file may not exist yet, and editors save
        // by replacing it, which ends a watch on the file itself.
        w = fsWatch(dir, { persistent: false }, (_event, name) => onChange(name ? String(name) : null))
      } catch {
        return null
      }
      w.on('error', () => w.close())
      return () => w.close()
    })
  let timer: ReturnType<typeof setTimeout> | null = null
  const stop = watch(dirname(opts.path), (name) => {
    if (name !== null && name !== file) return
    // A save is often several events (truncate, write, rename): read once they settle.
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      reload()
    }, 100)
    timer.unref?.()
  })
  return {
    get: () => current,
    problems: () => currentProblems,
    reload,
    close: () => {
      if (timer) clearTimeout(timer)
      stop?.()
    }
  }
}
