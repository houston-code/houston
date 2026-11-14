import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isDisabledFlag, parseFrontmatter } from '@shared/frontmatter'
import { mergeCommands, type Command } from '@shared/commands'
import { isReasoningEffort } from '@shared/agent'
import { loadSkills, skillCommands } from './skills'

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
/** Longest `argument-hint`, `model`, `agent` or `allowed-tools` value kept from frontmatter. */
const MAX_HINT_CHARS = 80
const MAX_FIELD_CHARS = 200
const MAX_ALLOWED_TOOLS_CHARS = 2000

/** A short single-line frontmatter value, or undefined when it is empty. */
function field(value: string | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.replace(/\s+/g, ' ').trim()
  return v ? v.slice(0, max) : undefined
}

/**
 * The frontmatter keys that change how a command runs, beyond its description:
 *
 *  - `argument-hint`: what may follow the name, shown beside it in the menus.
 *  - `model`: the model this one turn runs on (`provider/model`, a model id, or a provider).
 *  - `effort`: the thinking effort for this one turn (off, low, medium, high, xhigh).
 *  - `agent`: dispatch the expanded prompt to that `.houston/agents` subagent.
 *  - `allowed-tools`: tools pre-approved for this one turn, in permission-rule
 *    syntax. Honored only where it is safe to (see commandRun.ts).
 *
 * An unknown effort or a malformed agent name is dropped here, so the clients only
 * ever see values they can act on.
 */
export function commandOptions(data: Record<string, string>): Partial<Command> {
  const out: Partial<Command> = {}
  const hint = field(data['argument-hint'], MAX_HINT_CHARS)
  if (hint) out.args = hint
  const model = field(data.model, MAX_FIELD_CHARS)
  if (model) out.model = model
  const effort = field(data.effort, MAX_FIELD_CHARS)?.toLowerCase()
  if (isReasoningEffort(effort)) out.effort = effort
  const agent = field(data.agent, MAX_FIELD_CHARS)
  if (agent && /^[\w-]+$/.test(agent)) out.agent = agent
  let tools = field(data['allowed-tools'], MAX_ALLOWED_TOOLS_CHARS)
  // A YAML-style list on one line (`[read_file, glob]`) reads the same as a plain one.
  if (tools?.startsWith('[') && tools.endsWith(']')) tools = tools.slice(1, -1).trim() || undefined
  if (tools) out.allowedTools = tools
  return out
}

function firstLine(s: string): string {
  const line = (s.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim()
  return line.slice(0, 80)
}

/** Read one directory of `*.md` command files. Missing directory ⇒ no commands. */
async function loadFrom(dir: string, source: 'project' | 'user'): Promise<Command[]> {
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
    // Switched off (Settings > Customize writes `disabled: true`): kept on disk, not offered.
    if (isDisabledFlag(data.disabled)) continue
    const described = typeof data.description === 'string' ? data.description.trim() : ''
    // `body` is the whole file when there is no frontmatter, so it is always the
    // template. Falling back to `raw` would paste the frontmatter block into the
    // prompt for a file that is frontmatter and nothing else.
    const template = body.trim()
    if (!template) continue
    commands.push({
      name,
      description: (described || firstLine(template) || name).slice(0, 80),
      template: template.slice(0, MAX_TEMPLATE_CHARS),
      source,
      ...commandOptions(data)
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
    loadProjectCommands(workspace),
    loadFrom(join(home, USER_COMMANDS_DIR), 'user')
  ])
  return mergeCommands(project, user).sort((a, b) => a.name.localeCompare(b.name))
}

/** Just the workspace's own `.houston/commands` (what its trust fingerprint covers). */
export function loadProjectCommands(workspace: string): Promise<Command[]> {
  return loadFrom(join(workspace, COMMANDS_DIR), 'project')
}

/**
 * Everything a client offers after a slash beyond its built-ins: the custom commands
 * from {@link loadCommands}, then one `/<skill-name>` per loaded skill. A custom
 * command wins a name clash with a skill, as the built-ins win over both where the
 * clients merge them in.
 */
export async function loadSlashCommands(workspace: string, home: string = homedir()): Promise<Command[]> {
  const [commands, skills] = await Promise.all([loadCommands(workspace, home), loadSkills(workspace, home)])
  return mergeCommands(commands, skillCommands(skills))
}
