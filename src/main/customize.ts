import { promises as fs, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { isDisabledFlag, parseFrontmatter, parseStructuredFrontmatter } from '@shared/frontmatter'
import { isReservedCommandName } from '@shared/commands'
import { BUILTIN_SKILLS } from './agent/skills'
import { parseSkillFields } from './agent/skillSpec'
import { COMMAND_NAMESPACE_SEPARATOR, listCommandFiles } from './agent/commands'
import {
  isCustomName,
  type CustomItem,
  type CustomKind,
  type CustomScope,
  type CustomizeOverview,
  type CustomizeResult,
  type InstructionFile
} from '@shared/customize'
import { GLOBAL_RULES_DIRNAME, GLOBAL_RULES_FILE, GLOBAL_RULES_LABEL, RULES_FILES, loadProjectRules } from './agent/rules'
import { writeFileAtomicSync } from './atomic-write'
import { openPathSafely } from './safeOpen'

/**
 * Settings > Customize: list, create, switch on or off, open and delete the skills,
 * custom commands and custom agents in a project's `.houston/` and the user's
 * `~/.houston/`, and list the instruction files Houston loads for the project.
 *
 * The renderer only ever names an item by `<kind>:<scope>:<name>`; every path is
 * rebuilt here from that, the name is checked against the file-name charset, and a
 * file that resolves outside its folder (a symlink out of the project) is refused for
 * every change. Switching off writes `disabled: true` into the file's front matter, the
 * flag the loaders skip on, so it works the same in every client. Delete moves the
 * file or skill folder to the system trash rather than erasing it. Every open goes
 * through {@link openPathSafely} and only ever opens a regular `.md` file by its real
 * path: a committed `SKILL.md -> run.command` link would otherwise have the OS launch
 * the script (macOS picks the handler by the link's target).
 */

const MAX_ITEMS = 200

/**
 * Where items live under a project or the home folder: each kind's `.houston` folder,
 * plus `.agents/skills`, the Agent Skills format's own folder, as a second skill place.
 */
type Loc = CustomKind | 'skill-agents'
const DIRS: Record<Loc, string> = {
  skill: join('.houston', 'skills'),
  'skill-agents': join('.agents', 'skills'),
  command: join('.houston', 'commands'),
  agent: join('.houston', 'agents')
}

function isSkillLoc(loc: Loc): boolean {
  return loc === 'skill' || loc === 'skill-agents'
}

export interface CustomizeDeps {
  workspace: string | null
  home?: string
  /** Move a path to the system trash. */
  trash: (path: string) => Promise<void>
  /**
   * Open a file in its default app. Resolves to an error message, or '' on success.
   * Only ever called with the real path of a regular `.md` file (see openMarkdown).
   */
  open: (path: string) => Promise<string>
}

/**
 * Open a Markdown file Customize names. `within` confines a project file to the
 * project; the user's own folders are theirs to arrange, so they are not confined,
 * but the target must still be a regular `.md` file and is opened by its real path.
 */
function openMarkdown(path: string, within: string | null, deps: CustomizeDeps): Promise<CustomizeResult> {
  return openPathSafely(path, { open: deps.open }, { markdownOnly: true, ...(within ? { within } : {}) })
}

function under(root: string, abs: string): string | null {
  const rel = relative(root, abs)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return rel
}

function rootFor(scope: CustomScope, deps: CustomizeDeps): string | null {
  return scope === 'project' ? deps.workspace : (deps.home ?? homedir())
}

/** The folder holding all items of a kind for a scope. */
function kindDir(loc: Loc, root: string): string {
  return join(root, DIRS[loc])
}

/**
 * A command's name, which may carry its namespace folders (`git:commit` is
 * `git/commit.md`, up to three levels), each part a plain word as the loader reads it.
 */
const NAMESPACED_COMMAND = /^[\w-]{1,64}(?::[\w-]{1,64}){0,2}$/

/** Whether `name` is a valid name for an item of `loc`. */
function validName(loc: Loc, name: string): boolean {
  return loc === 'command' ? NAMESPACED_COMMAND.test(name) : isCustomName(name)
}

/** An item's own path: a skill's folder, or a command's or agent's file. */
function itemPath(loc: Loc, root: string, name: string): string {
  if (isSkillLoc(loc)) return join(kindDir(loc, root), name)
  const parts = loc === 'command' ? name.split(COMMAND_NAMESPACE_SEPARATOR) : [name]
  parts[parts.length - 1] = `${parts[parts.length - 1]}.md`
  return join(kindDir(loc, root), ...parts)
}

/** The file whose text describes the item (and holds its `disabled` flag). */
function itemFile(loc: Loc, root: string, name: string): string {
  return isSkillLoc(loc) ? join(itemPath(loc, root, name), 'SKILL.md') : itemPath(loc, root, name)
}

/** A skill's format fields as short lines for its row, and what breaks the format. */
function skillInfo(text: string, name: string): { details: string[]; problems: string[] } {
  const parsed = parseSkillFields(parseStructuredFrontmatter(text).fields, name, false)
  if (!parsed) return { details: [], problems: [] }
  const details: string[] = []
  if (parsed.allowedTools) details.push(`Tools: ${parsed.allowedTools.join(' ')}`)
  if (parsed.paths) details.push(`Paths: ${parsed.paths.join(', ')}`)
  if (parsed.license) details.push(`License: ${parsed.license}`)
  if (parsed.compatibility) details.push(`Compatibility: ${parsed.compatibility}`)
  return { details: details.map((d) => (d.length > 200 ? `${d.slice(0, 199)}…` : d)), problems: parsed.problems }
}

/** Whether `abs` resolves (symlinks followed) inside `root`. */
function resolvesInside(root: string, abs: string): boolean {
  try {
    const realRoot = realpathSync(root)
    return under(realRoot, realpathSync(abs)) !== null
  } catch {
    return false
  }
}

function shown(root: string, abs: string, scope: CustomScope): string {
  const rel = (under(root, abs) ?? abs).split(sep).join('/')
  return scope === 'user' ? `~/${rel}` : rel
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

function describe(text: string): string {
  const { data, body } = parseFrontmatter(text)
  const first = (body.split('\n', 1)[0] ?? '').replace(/^#+\s*/, '').trim()
  return (data.description?.trim() || first || 'No description.').slice(0, 160)
}

async function listKind(loc: Loc, scope: CustomScope, root: string): Promise<CustomItem[]> {
  const kind: CustomKind = isSkillLoc(loc) ? 'skill' : (loc as CustomKind)
  const dir = kindDir(loc, root)
  let names: string[]
  if (kind === 'command') {
    // Commands in namespace folders too, found exactly as the loader finds them.
    names = (await listCommandFiles(dir)).map((f) => f.name)
  } else {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    names = entries.flatMap((e) => {
      if (kind === 'skill') return e.isDirectory() ? [e.name] : []
      return e.isFile() && e.name.endsWith('.md') ? [e.name.slice(0, -3)] : []
    })
  }
  const items: CustomItem[] = []
  for (const name of names) {
    if (items.length >= MAX_ITEMS) break
    if (!validName(loc, name)) continue
    const file = itemFile(loc, root, name)
    const text = await readText(file)
    if (text === null) continue
    const info = kind === 'skill' ? skillInfo(text, name) : null
    items.push({
      id: `${loc}:${scope}:${name}`,
      kind,
      scope,
      name,
      description: describe(text),
      file: shown(root, file, scope),
      enabled: !isDisabledFlag(parseFrontmatter(text).data.disabled),
      ...(loc === 'skill-agents' ? { source: 'agents' as const } : {}),
      ...(info?.details.length ? { details: info.details } : {}),
      ...(info?.problems.length ? { problems: info.problems } : {})
    })
  }
  return items
}

/** The instruction files the rules loader takes in for this project, in load order. */
export async function listInstructionFiles(workspace: string | null, home: string = homedir()): Promise<InstructionFile[]> {
  if (!workspace) {
    const global = await readText(join(home, GLOBAL_RULES_DIRNAME, GLOBAL_RULES_FILE))
    return global?.trim() ? [{ label: GLOBAL_RULES_LABEL, scope: 'global' }] : []
  }
  const rules = await loadProjectRules(workspace, { home })
  const cut = new Set(rules.truncated ?? [])
  const labels = [...rules.files, ...(rules.truncated ?? []).filter((l) => !rules.files.includes(l))]
  return labels.map((label) => ({
    label,
    scope:
      label === GLOBAL_RULES_LABEL ? 'global' : (RULES_FILES as readonly string[]).includes(label) ? 'project' : 'nested',
    ...(cut.has(label) ? { truncated: true } : {})
  }))
}

/** Every skill, command and agent in both places, plus the loaded instruction files. */
export async function customizeOverview(deps: CustomizeDeps): Promise<CustomizeOverview> {
  const home = deps.home ?? homedir()
  // In precedence order (the skill loader's): project over user, `.houston` over `.agents`.
  const locs: Loc[] = ['skill', 'skill-agents', 'command', 'agent']
  const project = deps.workspace
    ? (await Promise.all(locs.map((k) => listKind(k, 'project', deps.workspace as string)))).flat()
    : []
  const user = (await Promise.all(locs.map((k) => listKind(k, 'user', home)))).flat()
  const taken = new Set<string>()
  for (const i of [...project, ...user]) {
    const key = `${i.kind}:${i.name.toLowerCase()}`
    if (taken.has(key)) i.shadowed = true
    else taken.add(key)
  }
  return { items: [...project, ...user], instructions: await listInstructionFiles(deps.workspace, home) }
}

/** An id split into its parts, with the paths it names; null for anything malformed. */
function parseId(
  id: unknown,
  deps: CustomizeDeps
): { kind: Loc; scope: CustomScope; name: string; root: string } | null {
  if (typeof id !== 'string') return null
  const m = /^(skill|skill-agents|command|agent):(project|user):(.+)$/.exec(id)
  if (!m || !validName(m[1] as Loc, m[3])) return null
  const root = rootFor(m[2] as CustomScope, deps)
  if (!root) return null
  return { kind: m[1] as Loc, scope: m[2] as CustomScope, name: m[3], root }
}

/**
 * The item's file, if it exists. A project's must also resolve inside the project, so
 * a committed link can't steer an edit or an open at a file elsewhere. The user's own
 * folder is theirs to arrange (it is often a link into a dotfiles repo).
 */
function existingFile(p: { kind: Loc; scope: CustomScope; root: string; name: string }): string | null {
  const file = itemFile(p.kind, p.root, p.name)
  if (p.scope === 'project') return resolvesInside(p.root, file) ? file : null
  try {
    realpathSync(file)
    return file
  } catch {
    return null
  }
}

/**
 * Front matter text with `disabled: true` added, or with the top-level `disabled:`
 * line removed. Every other line (a nested `disabled:` key, blank lines in a block
 * scalar) is kept, and the file keeps its CRLF line endings.
 */
export function withDisabledFlag(text: string, disabled: boolean): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const src = text.replace(/\r\n/g, '\n')
  const out = ((): string => {
    if (src.startsWith('---\n')) {
      const end = src.indexOf('\n---', 3)
      if (end !== -1) {
        const lines = src
          .slice(4, end)
          .split('\n')
          .filter((l) => !/^disabled\s*:/i.test(l))
        if (disabled) lines.push('disabled: true')
        const rest = src.slice(end + 1) // starts at the closing `---`
        return lines.some((l) => l.trim() !== '')
          ? `---\n${lines.join('\n')}\n${rest}`
          : rest.replace(/^---\n?/, '').replace(/^\n+/, '')
      }
    }
    return disabled ? `---\ndisabled: true\n---\n\n${src}` : src
  })()
  return eol === '\n' ? out : out.replace(/\n/g, eol)
}

/** Switch an item on or off by rewriting its front matter. */
export async function setItemEnabled(id: unknown, enabled: unknown, deps: CustomizeDeps): Promise<CustomizeResult> {
  const p = parseId(id, deps)
  if (!p || typeof enabled !== 'boolean') return { ok: false, error: 'Unknown item.' }
  const file = existingFile(p)
  if (!file) return { ok: false, error: 'That file is missing or outside its folder.' }
  const text = await readText(realpathSync(file))
  if (text === null) return { ok: false, error: "Couldn't read the file." }
  const next = withDisabledFlag(text, !enabled)
  // Compared line-ending blind, so a file with mixed endings isn't rewritten for nothing.
  if (next.replace(/\r\n/g, '\n') !== text.replace(/\r\n/g, '\n')) writeFileAtomicSync(realpathSync(file), next)
  return { ok: true }
}

/** Open an item's file in its default app. */
export async function openItem(id: unknown, deps: CustomizeDeps): Promise<CustomizeResult> {
  const p = parseId(id, deps)
  const file = p && existingFile(p)
  if (!file) return { ok: false, error: 'That file is missing or outside its folder.' }
  return openMarkdown(file, p.scope === 'project' ? p.root : null, deps)
}

/** Move an item (a skill's whole folder, or a command's or agent's file) to the trash. */
export async function deleteItem(id: unknown, deps: CustomizeDeps): Promise<CustomizeResult> {
  const p = parseId(id, deps)
  if (!p) return { ok: false, error: 'Unknown item.' }
  const target = itemPath(p.kind, p.root, p.name)
  // The item itself must sit inside its scope: its parent folder resolves inside the
  // project. The item is trashed as it is, so a skill folder that is a link goes as
  // the link, never the folder it points at.
  try {
    await fs.lstat(target)
    if (p.scope === 'project' && !resolvesInside(p.root, dirname(target))) {
      return { ok: false, error: 'That item is outside its folder.' }
    }
  } catch {
    return { ok: false, error: 'That item no longer exists.' }
  }
  try {
    await deps.trash(target)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `Couldn't move it to the trash: ${(e as Error).message}` }
  }
}

/** The starting text for a new item. */
export function templateFor(kind: CustomKind, name: string): string {
  switch (kind) {
    case 'skill':
      return `---\nname: ${name}\ndescription: When to use this skill, in one sentence.\n---\n\n# ${name}\n\nThe steps to follow when this skill applies. Other files in this folder (references, templates, scripts) can be mentioned here by name.\n`
    case 'command':
      return `---\ndescription: What /${name} does, in a few words.\n---\n\nThe task to run. $ARGUMENTS is replaced with whatever you type after /${name}.\n`
    case 'agent':
      return `---\ndescription: What this agent is for, in one sentence.\n---\n\nYou are a focused helper. Say what to look at, how to work, and what your final report should contain.\n`
  }
}

/** Create an item from its template (never over an existing one) and open it. */
export async function createItem(
  kind: unknown,
  scope: unknown,
  name: unknown,
  deps: CustomizeDeps
): Promise<CustomizeResult> {
  if (kind !== 'skill' && kind !== 'command' && kind !== 'agent') return { ok: false, error: 'Unknown kind.' }
  if (scope !== 'project' && scope !== 'user') return { ok: false, error: 'Unknown place.' }
  if (typeof name !== 'string' || !isCustomName(name.trim())) {
    return { ok: false, error: 'Use letters, digits, - or _ (up to 64).' }
  }
  const clean = name.trim()
  // A built-in wins its name in every client, so an item made under one never runs.
  if (kind === 'command' && isReservedCommandName(clean)) {
    return { ok: false, error: `/${clean} is a built-in command, so a custom one with that name would never run. Pick another name.` }
  }
  if (kind === 'skill' && BUILTIN_SKILLS.some((s) => s.name.toLowerCase() === clean.toLowerCase())) {
    return { ok: false, error: `${clean} is a built-in skill, so a custom one with that name would never load. Pick another name.` }
  }
  const root = rootFor(scope, deps)
  if (!root) return { ok: false, error: 'Open a project first.' }
  const dir = kindDir(kind, root)
  try {
    await fs.mkdir(dir, { recursive: true })
    // A project's `.houston` that links out of the project must not receive the file.
    if (scope === 'project' && !resolvesInside(root, dir)) return { ok: false, error: `${DIRS[kind]} is outside the project.` }
    if (kind === 'skill') await fs.mkdir(itemPath(kind, root, clean)) // fails if it exists
    await fs.writeFile(itemFile(kind, root, clean), templateFor(kind, clean), { flag: 'wx' })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return { ok: false, error: code === 'EEXIST' ? `There is already one named ${clean}.` : (e as Error).message }
  }
  const id = `${kind}:${scope}:${clean}`
  await openMarkdown(itemFile(kind, root, clean), scope === 'project' ? root : null, deps).catch(() => null)
  return { ok: true, id }
}

/** Open a loaded instruction file by its loader label (only labels the loader reports). */
export async function openInstructionFile(label: unknown, deps: CustomizeDeps): Promise<CustomizeResult> {
  const home = deps.home ?? homedir()
  const files = await listInstructionFiles(deps.workspace, home)
  const found = files.find((f) => f.label === label)
  if (!found) return { ok: false, error: 'That file is not loaded for this project.' }
  const path =
    found.scope === 'global'
      ? join(home, GLOBAL_RULES_DIRNAME, GLOBAL_RULES_FILE)
      : join(deps.workspace as string, ...found.label.split(/[\\/]/))
  // A project or nested file must resolve inside the project, and every one must be a
  // regular Markdown file: a committed `AGENTS.md -> run.command` is refused.
  return openMarkdown(path, found.scope === 'global' ? null : (deps.workspace as string), deps)
}
