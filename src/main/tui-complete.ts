/**
 * Tab-completion for the interactive composer: slash commands and `@`-file
 * mentions. The matching logic is pure (this file); the readline `completer`
 * wiring + the async file lookup live at the edges so this stays unit-testable.
 */

/** A built-in slash command, for completion + the (future) command menu. */
export interface CommandSpec {
  name: string
  description: string
}

export const COMMANDS: CommandSpec[] = [
  { name: 'help', description: 'show help' },
  { name: 'model', description: 'list or switch model' },
  { name: 'approval', description: 'show or set approval policy' },
  { name: 'clear', description: 'start a fresh conversation' },
  { name: 'new', description: 'start a fresh conversation' },
  { name: 'resume', description: 'reopen (or search) a saved session' },
  { name: 'fork', description: 'branch the current session into a copy' },
  { name: 'cost', description: 'session token + cost totals' },
  { name: 'skills', description: 'list workspace skills' },
  { name: 'agents', description: 'list custom agents' },
  { name: 'mcp', description: 'list configured MCP servers' },
  { name: 'hooks', description: 'list configured hooks' },
  { name: 'cwd', description: 'show the working directory' },
  { name: 'exit', description: 'leave' },
  { name: 'quit', description: 'leave' }
]

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
