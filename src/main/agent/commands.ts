import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '@shared/frontmatter'
import { mergeCommands, type Command } from '@shared/commands'

/**
 * Load custom slash commands.
 *
 * Three things were missing, each of which made a command harder to write than it
 * needed to be:
 *
 *  - **Workspace only.** A command you want in EVERY project — your review
 *    checklist, your commit style — had to be copied into every repo and updated
 *    in each one. Skills already have this shape; commands did not.
 *  - **No frontmatter.** The description was the template's first line, so the
 *    prompt began with a sentence written for a menu rather than for the model.
 *  - **$ARGUMENTS only.** A command that wants "the second word" had to make the
 *    user re-type it in the right shape, or parse prose and hope.
 *
 * Never throws: a broken command file is skipped, not fatal.
 */

export const COMMANDS_DIR = '.houston/commands'
/** Commands available in every project, mirroring where skills/agents look. */
export const USER_COMMANDS_DIR = join('.houston', 'commands')
const MAX_COMMANDS = 100
const MAX_TEMPLATE_CHARS = 16_000

function firstLine(s: string): string {
  const line = (s.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim()
  return line.slice(0, 80)
}

/** Read one directory of `*.md` command files. Missing directory ⇒ no commands. */
async function loadFrom(dir: string): Promise<Command[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
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
    let raw: string
    try {
      raw = (await fs.readFile(join(dir, e.name), 'utf8')).trim()
    } catch {
      continue
    }
    if (!raw) continue
    // Frontmatter is optional: without it, the first line is still the description,
    // exactly as before, so existing command files keep working untouched.
    const { data, body } = parseFrontmatter(raw)
    const described = typeof data.description === 'string' ? data.description.trim() : ''
    // `body` is the whole file when there is no frontmatter, so it is always the
    // template. Falling back to `raw` would paste the frontmatter block into the
    // prompt for a file that is frontmatter and nothing else.
    const template = body.trim()
    if (!template) continue
    commands.push({
      name,
      description: (described || firstLine(template) || name).slice(0, 80),
      template: template.slice(0, MAX_TEMPLATE_CHARS)
    })
  }
  return commands
}

/**
 * The workspace's commands, plus the user's own from `~/.houston/commands`.
 *
 * The workspace wins a name collision: a project's own definition of `/review` is
 * the one its contributors mean, and a personal command silently overriding it
 * would be a nasty surprise in someone else's repo.
 */
export async function loadCommands(workspace: string, home: string = homedir()): Promise<Command[]> {
  const [project, user] = await Promise.all([
    loadFrom(join(workspace, COMMANDS_DIR)),
    loadFrom(join(home, USER_COMMANDS_DIR))
  ])
  return mergeCommands(project, user).sort((a, b) => a.name.localeCompare(b.name))
}
