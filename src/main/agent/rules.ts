import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/**
 * Project-level agent instructions. Many repos ship an `AGENTS.md` (the emerging
 * cross-tool standard) or a `CLAUDE.md` describing conventions, build/test
 * commands, and house rules. Loading them into the system prompt lets the agent
 * follow a project's conventions without the user re-explaining them every time.
 */

/** Filenames read from the workspace root, in precedence order. */
export const RULES_FILES = ['AGENTS.md', 'CLAUDE.md'] as const

/** Cap the combined rules text so a huge file can't crowd out the context window. */
export const MAX_RULES_CHARS = 32_000

export interface ProjectRules {
  /** Combined, section-headed rules text (empty when no rules files exist). */
  text: string
  /** The rule filenames that were actually loaded. */
  files: string[]
}

/**
 * Read the known rules files from the workspace root and combine them. Only the
 * workspace root is consulted (no traversal), reads are size-capped, and any
 * unreadable or empty file is skipped. Never throws.
 */
export async function loadProjectRules(workspace: string): Promise<ProjectRules> {
  const parts: string[] = []
  const files: string[] = []
  let total = 0

  for (const name of RULES_FILES) {
    if (total >= MAX_RULES_CHARS) break
    let content: string
    try {
      content = (await fs.readFile(join(workspace, name), 'utf8')).trim()
    } catch {
      continue // missing or unreadable — skip
    }
    if (!content) continue
    const remaining = MAX_RULES_CHARS - total
    if (content.length > remaining) {
      content = `${content.slice(0, remaining)}\n[truncated]`
    }
    parts.push(`### ${name}\n${content}`)
    files.push(name)
    total += content.length
  }

  return { text: parts.join('\n\n'), files }
}
