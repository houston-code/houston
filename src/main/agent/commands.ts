import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Command } from '@shared/commands'

/**
 * Load custom slash commands from `.houston/commands/*.md` in the workspace. Each
 * file is a prompt template; the command name is the filename (without `.md`) and
 * the description is its first line. Never throws.
 */

export const COMMANDS_DIR = '.houston/commands'
const MAX_COMMANDS = 100
const MAX_TEMPLATE_CHARS = 16_000

function firstLine(s: string): string {
  const line = (s.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim()
  return line.slice(0, 80)
}

export async function loadCommands(workspace: string): Promise<Command[]> {
  let entries
  try {
    entries = await fs.readdir(join(workspace, COMMANDS_DIR), { withFileTypes: true })
  } catch {
    return [] // no commands dir — fine
  }
  // Sort BEFORE the MAX_COMMANDS cap so which commands survive truncation is
  // deterministic across platforms (fs.readdir order isn't), matching plugins.ts.
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const commands: Command[] = []
  for (const e of entries) {
    if (commands.length >= MAX_COMMANDS) break
    if (!e.isFile() || !e.name.endsWith('.md')) continue
    const name = e.name.slice(0, -'.md'.length)
    if (!/^[\w-]+$/.test(name)) continue // sane, mention-safe command names only
    let content: string
    try {
      content = (await fs.readFile(join(workspace, COMMANDS_DIR, e.name), 'utf8')).trim()
    } catch {
      continue
    }
    if (!content) continue
    commands.push({
      name,
      description: firstLine(content) || name,
      template: content.slice(0, MAX_TEMPLATE_CHARS)
    })
  }
  commands.sort((a, b) => a.name.localeCompare(b.name))
  return commands
}
