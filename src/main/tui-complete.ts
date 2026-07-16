/**
 * Tab-completion for the interactive composer: slash commands and `@`-file
 * mentions. The matching logic is pure (this file); the readline `completer`
 * wiring + the async file lookup live at the edges so this stays unit-testable.
 */
import { builtinCommands } from '@shared/commands'

/** A slash command, for completion and the live menu. */
export interface CommandSpec {
  name: string
  description: string
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
  const m = /^\/([a-z?]*)$/.exec(line)
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
  const mention = mentionQuery(line)
  if (mention !== null) {
    return [files.map((f) => `@${f} `), `@${mention}`]
  }
  return [[], line]
}

/** A file finder for the completer (workspace-bound, injected). */
export type FileFinder = (query: string) => Promise<string[]>

/**
 * Build an async readline completer from a command list and a file finder. Only
 * hits the filesystem when the current token is an `@`-mention.
 */
export function makeCompleter(finder: FileFinder, commands: CommandSpec[] = COMMANDS) {
  return (line: string, callback: (err: null, result: [string[], string]) => void): void => {
    const mention = mentionQuery(line)
    if (mention === null) {
      callback(null, completeInput(line, [], commands))
      return
    }
    finder(mention)
      .then((files) => callback(null, completeInput(line, files, commands)))
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
  if (q === null) return null
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
  const shown = matches.slice(0, MENU_LIMIT)
  const width = Math.max(...shown.map((c) => c.name.length))
  const rows = shown.map(
    (c) => `  ${paint(`/${c.name}`.padEnd(width + 1), 'cyan')}  ${paint(c.description, 'dim')}`
  )
  if (matches.length > shown.length) {
    rows.push(paint(`  … ${matches.length - shown.length} more`, 'dim'))
  }
  return rows
}
