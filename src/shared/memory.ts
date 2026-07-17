/**
 * `#`-capture: turning "it should always do X", noticed mid-conversation, into a
 * standing instruction without leaving to open an editor.
 *
 * Houston already reads AGENTS.md / CLAUDE.md from the project and from ~/.claude
 * on every run, so the mechanism for standing instructions exists. What was missing
 * was any way to ADD one in the moment — and the moment you notice it is exactly
 * when you are least likely to open a file and write it down. Pure + shared so the
 * terminal and the desktop app recognize a capture identically.
 */

/** Where a remembered instruction goes: this project, or every project. */
export type MemoryScope = 'project' | 'global'

/** Longest standing instruction accepted — a note is a sentence or two, not an essay. */
export const MAX_MEMORY_NOTE = 2000

/**
 * A `#`-prefixed line: the standing instruction to remember, or null when the line
 * isn't one. `#` alone isn't a note, and neither is a bare markdown heading.
 */
export function parseMemoryCapture(line: string): string | null {
  if (!line.startsWith('#')) return null
  const text = line.replace(/^#+/, '').trim()
  return text || null
}
