import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { MemoryScope } from '@shared/memory'
import { writeFileAtomicSync } from './atomic-write'

/**
 * Persist a `#`-captured standing instruction. Shared by the terminal and the
 * desktop app so both write it the same way.
 *
 * Houston already reads AGENTS.md from the project and from ~/.claude on every run,
 * so this writes to the file that machinery ALREADY loads rather than inventing a
 * store. `project` scope writes the workspace's AGENTS.md; `global` writes
 * ~/.claude/AGENTS.md, which applies everywhere. Returns the path written.
 */
export async function saveMemory(
  workspace: string,
  scope: MemoryScope,
  text: string
): Promise<string> {
  return saveMemoryTo(scope === 'project' ? workspace : join(homedir(), '.claude'), text)
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
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

/** Append `text` as a note to `dir`'s rules file. Exported for tests. */
export async function saveMemoryTo(dir: string, text: string): Promise<string> {
  const note = oneLine(text)
  const file = join(dir, 'AGENTS.md')
  const existing = safeRead(file)
  const heading = '## Notes'
  let next: string
  if (existing === null) {
    next = `# Project instructions\n\n${heading}\n\n- ${note}\n`
  } else if (existing.includes(heading)) {
    // Append inside the existing Notes section, so related notes stay together.
    const at = existing.indexOf(heading) + heading.length
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
