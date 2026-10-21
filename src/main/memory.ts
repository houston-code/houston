import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryScope } from '@shared/memory'
import { writeFileAtomicSync } from './atomic-write'
import { GLOBAL_RULES_HEADING, globalRulesDir, readTextOrNull } from './globalRules'
import { neutralizeImports } from './agent/rules'

/**
 * Persist a `#`-captured standing instruction. Shared by the terminal and the
 * desktop app so both write it the same way.
 *
 * Houston already reads the project's AGENTS.md and the global ~/.houston/AGENTS.md
 * on every run, so this writes to the file that machinery ALREADY loads rather than
 * inventing a store. `project` scope writes the workspace's AGENTS.md; `global`
 * writes ~/.houston/AGENTS.md, which applies everywhere. Returns the path written.
 */
export async function saveMemory(
  workspace: string,
  scope: MemoryScope,
  text: string
): Promise<string> {
  return scope === 'project'
    ? saveMemoryTo(workspace, text)
    : saveMemoryTo(globalRulesDir(), text, GLOBAL_RULES_HEADING)
}

/**
 * Flatten a note to a single line. A note is written as one `- …` bullet, so an
 * embedded newline would break out of the bullet — and a `\n## ` would escape the
 * `## Notes` section entirely and read as a first-class instruction heading. The
 * TUI's single-line composer can't produce this, but the GUI composer can (Shift-
 * Enter), and either could carry a note pasted from elsewhere, so the shared write
 * collapses any run of whitespace containing a newline down to a single space.
 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim()
}

/**
 * A note as stored: one line, with any @path mention made inert. Rules files expand
 * `@path` as an import, so without this a note that only names a path would put that
 * file's contents into every prompt.
 */
function storedNote(text: string): string {
  return neutralizeImports(oneLine(text))
}

/**
 * Append `text` as a note to `dir`'s rules file, creating it under `title` when it
 * doesn't exist yet. Exported for tests.
 */
export async function saveMemoryTo(
  dir: string,
  text: string,
  title = '# Project instructions'
): Promise<string> {
  const note = storedNote(text)
  const file = join(dir, 'AGENTS.md')
  const existing = readTextOrNull(file)
  const heading = '## Notes'
  // The Notes heading itself, alone on its line: a bare substring search also hit
  // "### Notes" or "## Notes on deployment" and filed the note under that heading.
  const headingLine = /^## Notes[ \t]*$/m.exec(existing ?? '')
  let next: string
  if (existing === null) {
    next = `${title}\n\n${heading}\n\n- ${note}\n`
  } else if (headingLine) {
    // Append inside the existing Notes section, so related notes stay together.
    const at = headingLine.index + headingLine[0].length
    const rest = existing.slice(at)
    const nextHeading = rest.search(/\n## /)
    const insertAt = nextHeading === -1 ? existing.length : at + nextHeading
    next = `${existing.slice(0, insertAt).replace(/\s+$/, '')}\n- ${note}\n${existing.slice(insertAt)}`
  } else {
    next = `${existing.replace(/\s+$/, '')}\n\n${heading}\n\n- ${note}\n`
  }
  mkdirSync(dir, { recursive: true })
  // Atomic write (temp + rename, with a unique temp name so two saves can't race on
  // it): a half-written rules file would be loaded on the very next turn, and a
  // truncated instruction is worse than none.
  writeFileAtomicSync(file, next)
  return file
}
