/**
 * Tab-completion for the interactive composer: slash commands and `@`-file
 * mentions. The matching logic is pure (this file); the readline `completer`
 * wiring + the async file lookup live at the edges so this stays unit-testable.
 */
import { isAbsolute, join } from 'node:path'
import { builtinCommands } from '@shared/commands'
import { stripControlChars } from './tui-wrap'

/** A slash command, for completion and the live menu. */
export interface CommandSpec {
  name: string
  description: string
  /** What may follow the name (a built-in's `args`, a custom command's `argument-hint`), shown dim beside it. */
  args?: string
}

/** The TUI's built-in commands, derived from the shared catalog (single source). */
export const COMMANDS: CommandSpec[] = builtinCommands('tui')

/** The `@<query>` mention token at the end of `line`, or null if not in one. */
export function mentionQuery(line: string): string | null {
  const m = /(?:^|\s)@([^\s]*)$/.exec(line)
  return m ? m[1] : null
}

/** The `/<query>` command token when the whole line is a single command word. */
export function commandQuery(line: string): string | null {
  // Custom `.houston/commands` names may hold digits, `-`, `_`, and capitals; a
  // lowercase-only pattern dropped the menu as soon as one was typed (`/fix-`). A
  // namespaced command (`.houston/commands/git/commit.md`) is `/git:commit`.
  const m = /^\/([\w?:-]*)$/.exec(line)
  return m ? m[1] : null
}

/**
 * The `/<query>` token at the end of `line` after a space, mid-message ("then run
 * /rev"). Completion only: a command runs only when the message starts with it, so
 * this lets a user write a command name into prose (or set one up to send next)
 * without retyping it. Null at the start of the line (that is {@link commandQuery}).
 */
export function inlineCommandQuery(line: string): string | null {
  const m = /\s\/([\w:-]*)$/.exec(line)
  return m ? m[1] : null
}

/**
 * Produce a readline-style completion tuple `[completions, substring]` for the
 * current line. `files` are workspace-relative paths already matched against the
 * mention query by the caller (via findFiles). Command completion needs no I/O.
 */
export function completeInput(
  line: string,
  files: string[],
  commands: CommandSpec[] = COMMANDS
): [string[], string] {
  const cmd = commandQuery(line)
  if (cmd !== null) {
    const hits = commands
      .filter((c) => c.name.startsWith(cmd))
      .map((c) => `/${c.name} `)
    return [hits, line]
  }
  const inline = inlineCommandQuery(line)
  if (inline !== null) {
    const hits = commands
      .filter((c) => c.name.toLowerCase().startsWith(inline.toLowerCase()))
      .map((c) => `/${c.name} `)
    return [hits, `/${inline}`]
  }
  const mention = mentionQuery(line)
  if (mention !== null) {
    return [files.map((f) => `@${f} `), `@${mention}`]
  }
  return [[], line]
}

/** A file finder for the completer (workspace-bound, injected). */
export type FileFinder = (query: string) => Promise<string[]>

/** The folder being typed after `/cd` or `/add-dir`, or null when the line is not that. */
export function folderArgQuery(line: string): string | null {
  const m = /^\/(?:cd|add-dir)\s+(\S*)$/.exec(line)
  return m ? m[1] : null
}

/** Folders that complete a `/cd` or `/add-dir` argument (injected; reads the disk). */
export type FolderLister = (partial: string) => Promise<string[]>

/** One entry of a folder, as {@link folderCompletions} reads it. */
export interface FolderEntry {
  name: string
  /** A folder, or a link to one. */
  isDir: boolean
}

/** Most folders one Tab offers. */
const FOLDER_COMPLETION_LIMIT = 100

/**
 * The folders that complete `partial` (`../sh`, `~/work/`, `src`), each written the way
 * it was typed plus the rest of the name and a `/`. Relative paths start at `cwd`, a
 * leading `~` at `home`. Hidden folders are offered only once a `.` is typed, and a
 * name with spaces or control characters is left out (it could not be typed back as
 * one word, or would reach the terminal as an escape sequence).
 */
export async function folderCompletions(
  partial: string,
  cwd: string,
  home: string,
  readDir: (dir: string) => Promise<FolderEntry[]>
): Promise<string[]> {
  // Windows also takes a backslash between folders.
  const slash = Math.max(partial.lastIndexOf('/'), process.platform === 'win32' ? partial.lastIndexOf('\\') : -1)
  const head = slash >= 0 ? partial.slice(0, slash + 1) : ''
  const prefix = slash >= 0 ? partial.slice(slash + 1) : partial
  if (partial === '~') return home ? ['~/'] : []
  const expanded = head.startsWith('~/') ? (home ? `${home}${head.slice(1)}` : null) : head
  if (expanded === null) return []
  const dir = isAbsolute(expanded) ? expanded : join(cwd, expanded || '.')
  let entries: FolderEntry[]
  try {
    entries = await readDir(dir)
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isDir && e.name.startsWith(prefix))
    .filter((e) => prefix.startsWith('.') || !e.name.startsWith('.'))
    // eslint-disable-next-line no-control-regex
    .filter((e) => !/[\s\u0000-\u001f\u007f-\u009f]/.test(e.name))
    .map((e) => e.name)
    .sort()
    .slice(0, FOLDER_COMPLETION_LIMIT)
    .map((name) => `${head}${name}/`)
}

/**
 * Build an async readline completer from a command list and a file finder. Only
 * hits the filesystem when the current token is an `@`-mention.
 */
export function makeCompleter(
  finder: FileFinder,
  /** Read at each Tab, so commands loaded after startup (a workspace's own) complete too. */
  commands: CommandSpec[] | (() => CommandSpec[]) = COMMANDS,
  /** Completes the folder after `/cd` and `/add-dir`; absent, those complete nothing. */
  folders?: FolderLister
) {
  const current = (): CommandSpec[] => (typeof commands === 'function' ? commands() : commands)
  return (line: string, callback: (err: null, result: [string[], string]) => void): void => {
    const folder = folderArgQuery(line)
    if (folder !== null && folders) {
      folders(folder)
        .then((hits) => callback(null, [hits, folder]))
        .catch(() => callback(null, [[], line]))
      return
    }
    const mention = mentionQuery(line)
    if (mention === null) {
      callback(null, completeInput(line, [], current()))
      return
    }
    finder(mention)
      .then((files) => callback(null, completeInput(line, files, current())))
      .catch(() => callback(null, [[], line]))
  }
}

/** How many rows the menu shows before it stops listing. */
export const MENU_LIMIT = 8

/**
 * The commands to offer for the line being typed, or null when the line is not a
 * bare command word.
 *
 * The terminal had Tab completion that printed bare names (`/help /hooks`) with no
 * descriptions, no argument hints, and — because the completer only ever knew the
 * BUILT-IN list — no sign that a workspace's own `.houston/commands` existed at
 * all. You had to know a command's name to discover it, which is the opposite of
 * what a command menu is for.
 */
export function commandMenu(line: string, commands: CommandSpec[]): CommandSpec[] | null {
  const q = commandQuery(line)
  if (q === null) {
    // Mid-message, a `/` token lists the commands it could complete to, but only
    // when one matches: a path in prose ("see /usr/lib") shows nothing.
    const inline = inlineCommandQuery(line)
    if (inline === null) return null
    const p = inline.toLowerCase()
    const hits = commands.filter((c) => c.name.toLowerCase().startsWith(p))
    return hits.length ? hits : null
  }
  const p = q.toLowerCase()
  // Every match: the renderer caps the list, so it can say how many it left out.
  return commands.filter((c) => c.name.toLowerCase().startsWith(p))
}

/**
 * Render the menu rows shown under the composer. Pure; the adapter owns placement.
 * The whole list is deliberately shown for a bare `/`, since that IS the "what can
 * I do here?" gesture.
 */
export function renderCommandMenu(
  matches: CommandSpec[],
  paint: (s: string, ...styles: string[]) => string
): string[] {
  if (!matches.length) return [paint('  (no matching command)', 'dim')]
  // A workspace's commands and skills describe themselves from files in the repo:
  // nothing from them reaches the terminal as an escape sequence.
  const shown = matches.slice(0, MENU_LIMIT).map((c) => ({
    name: stripControlChars(c.name),
    description: stripControlChars(c.description),
    ...(c.args ? { args: stripControlChars(c.args) } : {})
  }))
  const width = Math.max(...shown.map((c) => c.name.length + (c.args ? c.args.length + 1 : 0)))
  const rows = shown.map((c) => {
    // The hint sits dim beside the name, like the desktop menu's.
    const pad = ' '.repeat(Math.max(0, width - c.name.length - (c.args ? c.args.length + 1 : 0)))
    const name = paint(`/${c.name}`, 'cyan')
    const hint = c.args ? ` ${paint(c.args, 'dim')}` : ''
    return `  ${name}${hint}${pad}   ${paint(c.description, 'dim')}`
  })
  if (matches.length > shown.length) {
    rows.push(paint(`  … ${matches.length - shown.length} more`, 'dim'))
  }
  return rows
}

/** Render the `@` mention rows: matching paths, capped like the command menu. */
export function renderMentionMenu(
  files: string[],
  paint: (s: string, ...styles: string[]) => string
): string[] {
  if (!files.length) return [paint('  (no matching file)', 'dim')]
  const shown = files.slice(0, MENU_LIMIT)
  // A file's name is the repository's text: nothing in it reaches the terminal as an
  // escape sequence (any byte but `/` and NUL is legal in one).
  const rows = shown.map((f) => `  ${paint(`@${stripControlChars(f)}`, 'cyan')}`)
  if (files.length > shown.length) rows.push(paint(`  … ${files.length - shown.length} more`, 'dim'))
  rows.push(paint('  Up/Down to choose, Tab completes', 'dim'))
  return rows
}

/** One row of the live menu that can be picked: the token before the cursor it replaces, and with what. */
export interface MenuOption {
  replace: string
  insert: string
}

/**
 * The live menu under the composer: its rows, and what its first rows insert when
 * picked. `options[i]` is drawn as `rows[i]`; any rows after them are notes
 * ("… 3 more", a key hint).
 */
export interface MenuView {
  rows: string[]
  options: MenuOption[]
}

/** The command menu for the text before the cursor, as rows and pickable options. */
export function commandMenuView(
  before: string,
  commands: CommandSpec[],
  paint: (s: string, ...styles: string[]) => string
): MenuView | null {
  const matches = commandMenu(before, commands)
  if (!matches) return null
  // The whole line is the command word, or (mid-message) the `/word` at its end.
  const replace = commandQuery(before) !== null ? before : `/${inlineCommandQuery(before) ?? ''}`
  return {
    rows: renderCommandMenu(matches, paint),
    options: matches.slice(0, MENU_LIMIT).map((c) => ({ replace, insert: `/${c.name} ` }))
  }
}

/** The menu's rows with option `selected` pointed at, as the pickers draw a highlight. */
export function markMenuRow(
  view: MenuView,
  selected: number | null,
  paint: (s: string, ...styles: string[]) => string
): string[] {
  if (selected === null || selected >= view.options.length) return view.rows
  return view.rows.map((r, i) => (i === selected ? `${paint('›', 'cyan')} ${r.replace(/^ {2}/, '')}` : r))
}

/**
 * The live `@` dropdown: matching files under the composer as the mention is typed,
 * as `/` shows commands. The lookup is async, so the first draw for a new query shows
 * the last rows (or none) and `redraw` repaints once the files are in. Only the newest
 * query's answer is kept; a slow lookup for an older one is dropped. The rows are
 * painted on each call, with the caller's painter when it passes one, so a theme
 * change applies to a menu already open. Rows still showing an older query's files
 * can't be picked: they would replace the token with a path it no longer matches.
 */
export function makeMentionMenuView(
  finder: FileFinder,
  paint: (s: string, ...styles: string[]) => string
): (line: string, redraw: () => void, paintNow?: (s: string, ...styles: string[]) => string) => MenuView | null {
  let shown: { query: string; files: string[] } | null = null
  let wanted: string | null = null
  return (line, redraw, paintNow = paint) => {
    const q = mentionQuery(line)
    if (q === null) {
      wanted = null
      return null
    }
    if (shown?.query === q) {
      return {
        rows: renderMentionMenu(shown.files, paintNow),
        options: shown.files.slice(0, MENU_LIMIT).map((f) => ({ replace: `@${q}`, insert: `@${f} ` }))
      }
    }
    if (wanted !== q) {
      wanted = q
      finder(q)
        .then((files) => {
          if (wanted !== q) return
          shown = { query: q, files }
          redraw()
        })
        .catch(() => {
          /* no files to offer: the menu stays as it was, Tab still works */
        })
    }
    return { rows: shown ? renderMentionMenu(shown.files, paintNow) : [], options: [] }
  }
}

/** {@link makeMentionMenuView}, rows only. */
export function makeMentionMenu(
  finder: FileFinder,
  paint: (s: string, ...styles: string[]) => string
): (line: string, redraw: () => void, paintNow?: (s: string, ...styles: string[]) => string) => string[] | null {
  const view = makeMentionMenuView(finder, paint)
  return (line, redraw, paintNow) => view(line, redraw, paintNow)?.rows ?? null
}
