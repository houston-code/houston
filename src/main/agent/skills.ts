import { promises as fs, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isDisabledFlag, parseFrontmatter, parseStructuredFrontmatter } from '@shared/frontmatter'
import { HOUSTON_GUIDE } from './guide-content'
import { RENDER_UI_SKILL } from './render-ui-skill'
import { parseSkillFields, skillMatchesPath, workspaceRelative, type SkillSpecFields } from './skillSpec'
import { touchedFilePaths } from './workingMemory'
import type { ChatMessage } from '@shared/agent'
import type { Command } from '@shared/commands'

/**
 * Skills: reusable instruction bundles in `.houston/skills/<name>/SKILL.md`. Each
 * SKILL.md has front-matter `name`/`description` and a body of instructions. Only
 * the name + description are injected into the system prompt (cheap); the agent
 * loads the full SKILL.md on demand via the `skill` tool (or read_file the path) —
 * progressive disclosure.
 *
 * A skill can bundle more than its SKILL.md: any other files in the skill directory
 * (references, templates, scripts) are resources the instructions can lean on. Those
 * are discovered at load time and listed at the end of the `skill` tool's response so
 * the agent knows they exist and can `read_file`/run them — a second level of
 * progressive disclosure, the SKILL.md body itself staying the first.
 */

export const SKILLS_DIR = '.houston/skills'
/** Skills available in every project, under the home folder (`~/.houston/skills`). */
export const USER_SKILLS_DIR = join('.houston', 'skills')
/**
 * The Agent Skills format's own folder (agentskills.io), read in a project and under
 * the home folder (`~/.agents/skills`) alongside `.houston/skills`. Skills found here
 * are held to the format: one whose name or description breaks it is not loaded.
 */
export const AGENTS_SKILLS_DIR = '.agents/skills'
export const USER_AGENTS_SKILLS_DIR = join('.agents', 'skills')
const MAX_SKILLS = 50
/** Bound the per-skill resource walk so a huge skill directory can't blow up load. */
const MAX_SKILL_RESOURCES = 100
const MAX_SKILL_DEPTH = 8

export interface Skill extends SkillSpecFields {
  name: string
  description: string
  /** Where it was found: `.agents/skills` (the open format's folder), else `.houston/skills`. */
  source?: 'agents'
  /**
   * Path to the skill's instructions, for the agent to read: workspace-relative for a
   * project skill, absolute for one of the user's own (see `root`).
   */
  path: string
  /**
   * The user's skills folder, for a skill loaded from `~/.houston/skills`: its `path`
   * is absolute and must stay inside this folder. Absent for a project skill.
   */
  root?: string
  /**
   * Workspace-relative paths of the skill's other bundled files (everything in the
   * skill directory except its SKILL.md), sorted. Present only when non-empty.
   */
  resources?: string[]
  /**
   * In-memory instructions for a built-in skill (one that ships with Houston
   * rather than living in a workspace file). When set, {@link loadSkillBody}
   * serves this directly instead of reading `path` from the workspace.
   */
  body?: string
  /**
   * Built-in skills only: tools the run must offer for this skill to be listed. A
   * skill whose instructions lean on a desktop-only tool would only mislead a run
   * that can't call it.
   */
  requiresTools?: readonly string[]
}

/**
 * Collect a skill's bundled resource files: every file under the skill directory
 * except its top-level SKILL.md, as sorted workspace-relative paths. Bounded in depth
 * and count. Symlinks are skipped (never followed), so a link can't be used to list —
 * and thereby advertise for reading — a file outside the skill dir; `read_file`'s own
 * containment is the backstop if the agent tries anyway.
 */
async function collectSkillResources(absSkillDir: string, relSkillDir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (absDir: string, relDir: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH || out.length >= MAX_SKILL_RESOURCES) return
    let entries
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      if (out.length >= MAX_SKILL_RESOURCES) break
      const rel = `${relDir}/${e.name}`
      if (e.isDirectory()) {
        await walk(join(absDir, e.name), rel, depth + 1)
      } else if (e.isFile()) {
        if (depth === 0 && e.name === 'SKILL.md') continue // the instructions themselves
        out.push(rel)
      }
      // Anything else (a symlink, a socket) is intentionally ignored.
    }
  }
  await walk(absSkillDir, relSkillDir, 0)
  return out
}

/**
 * Skills that ship with Houston itself, present in every run regardless of the
 * workspace. `houston-guide` lets the agent answer questions about Houston's own
 * features from an authoritative source instead of guessing (the system prompt
 * points the agent at it). Its body is compiled in via {@link HOUSTON_GUIDE}, so
 * there is no workspace file to read.
 *
 * These are merged into the agent's skill list at the run seam (see
 * {@link withBuiltinSkills}), NOT inside {@link loadSkills}, so the `/skills`
 * command keeps listing only the project's and the user's own skills.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'houston-guide',
    description:
      "How Houston itself works: its slash commands, skills, subagents, hooks, plugins, MCP servers, approval modes and permission rules, plan mode, sandboxing, GitHub tools, settings, and its license. Load this to answer any question about Houston's own features or licensing.",
    path: '(built-in)',
    body: HOUSTON_GUIDE
  },
  {
    name: 'render-ui',
    description:
      'How to show the user how a UI looks or will look: capture the running app (web, Electron, mobile simulator) or render a mockup from the project\'s own styles, cover the states that matter, check each image, and present them with show_images.',
    path: '(built-in)',
    body: RENDER_UI_SKILL,
    requiresTools: ['show_images']
  }
]

/**
 * Merge Houston's built-in skills with a workspace's loaded skills for the agent
 * runtime. Built-ins win a name collision, so a workspace can't shadow (or
 * silently override) `houston-guide`. With `offeredTools`, a built-in whose
 * `requiresTools` the run doesn't offer is left out; its name stays reserved all the
 * same, so a workspace skill can't step into the gap under a trusted name.
 */
export function withBuiltinSkills(workspaceSkills: Skill[], offeredTools?: readonly string[]): Skill[] {
  const reserved = new Set(BUILTIN_SKILLS.map((s) => s.name.toLowerCase()))
  const offered = offeredTools ? new Set(offeredTools) : null
  const builtins = BUILTIN_SKILLS.filter(
    (s) => !offered || !s.requiresTools || s.requiresTools.every((t) => offered.has(t))
  )
  const merged = [...builtins, ...workspaceSkills.filter((s) => !reserved.has(s.name.toLowerCase()))]
  merged.sort((a, b) => a.name.localeCompare(b.name))
  return merged
}

/**
 * Whether `abs` resolves, through any symlinks, to a file inside `workspace`. A
 * skill's SKILL.md comes from the repo, so it is attacker-controlled when an untrusted
 * repo is opened, and its body reaches the model through the `skill` tool, which needs
 * no approval. A SKILL.md that is a symlink out of the tree would hand the model a host
 * file (a private key, a credentials file) without the prompt a direct read of it gets.
 */
function resolvesInsideWorkspace(abs: string, workspace: string): boolean {
  try {
    const root = realpathSync(workspace)
    const rel = relative(root, realpathSync(abs))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  } catch {
    return false // missing or unreadable: nothing to load anyway
  }
}

/**
 * Read one skills folder. `display(name)` is the skill directory as the agent should
 * see it (workspace-relative for a project, absolute for the user's folder), and every
 * SKILL.md must resolve inside `confine`.
 */
async function loadSkillsFrom(
  dir: string,
  confine: string,
  display: (name: string) => string,
  root?: string,
  source?: 'agents'
): Promise<Skill[]> {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  // Sort BEFORE the MAX_SKILLS cap so which skills survive truncation is deterministic
  // and stable across platforms (fs.readdir order isn't), matching plugins.ts.
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const skills: Skill[] = []
  for (const e of entries) {
    if (skills.length >= MAX_SKILLS) break
    if (!e.isDirectory()) continue
    if (!/^[\w-]+$/.test(e.name)) continue
    const file = join(dir, e.name, 'SKILL.md')
    if (!resolvesInsideWorkspace(file, confine)) continue
    let raw: string
    try {
      raw = (await fs.readFile(file, 'utf8')).trim()
    } catch {
      continue // a dir without a SKILL.md isn't a skill
    }
    if (!raw) continue
    const { fields } = parseStructuredFrontmatter(raw)
    // Switched off (Settings > Customize writes `disabled: true`): kept on disk, not offered.
    if (isDisabledFlag(typeof fields.disabled === 'string' ? fields.disabled : undefined)) continue
    // `.agents/skills` is held to the format; `.houston/skills` predates it and keeps
    // loading what it always did.
    const spec = parseSkillFields(fields, e.name, source === 'agents')
    if (!spec) continue
    const { problems: _problems, ...parsed } = spec
    const skillDir = display(e.name)
    const resources = await collectSkillResources(join(dir, e.name), skillDir)
    skills.push({
      ...parsed,
      path: `${skillDir}/SKILL.md`,
      ...(root ? { root } : {}),
      ...(resources.length ? { resources } : {}),
      ...(source ? { source } : {})
    })
  }
  return skills
}

/**
 * The workspace's skills (`.houston/skills` and `.agents/skills`), plus the user's
 * own from `~/.houston/skills` and `~/.agents/skills`. On a name clash the project
 * wins over the user, as it does for commands (a project's own definition is the one
 * its contributors mean), and within each place `.houston` wins over `.agents`.
 */
export async function loadSkills(workspace: string, home: string = homedir()): Promise<Skill[]> {
  const userDir = join(home, USER_SKILLS_DIR)
  const userAgentsDir = join(home, USER_AGENTS_SKILLS_DIR)
  // In precedence order: the first skill to take a name keeps it.
  const tiers = await Promise.all([
    loadSkillsFrom(join(workspace, SKILLS_DIR), workspace, (name) => `${SKILLS_DIR}/${name}`),
    loadSkillsFrom(
      join(workspace, AGENTS_SKILLS_DIR),
      workspace,
      (name) => `${AGENTS_SKILLS_DIR}/${name}`,
      undefined,
      'agents'
    ),
    loadSkillsFrom(userDir, userDir, (name) => join(userDir, name), userDir),
    loadSkillsFrom(userAgentsDir, userAgentsDir, (name) => join(userAgentsDir, name), userAgentsDir, 'agents')
  ])
  const taken = new Set<string>()
  const skills: Skill[] = []
  for (const s of tiers.flat()) {
    if (skills.length >= MAX_SKILLS) break
    const key = s.name.toLowerCase()
    if (taken.has(key)) continue
    taken.add(key)
    skills.push(s)
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

/**
 * Read a skill's full instructions — the SKILL.md body with front-matter stripped —
 * for the `skill` tool to return on demand. Returns null when the file is missing or
 * empty. `skill.path` comes from {@link loadSkills}, so it's already a validated
 * workspace-relative path.
 */
export async function loadSkillBody(workspace: string, skill: Skill): Promise<string | null> {
  // Built-in skills carry their instructions in memory (no workspace file).
  if (skill.body !== undefined) {
    const text = skill.body.trim()
    return text || null
  }
  // Checked again at read time: the file can have been swapped for a symlink since the
  // skill list was built at the start of the run. A user skill stays inside its folder.
  const abs = skill.root ? skill.path : join(workspace, skill.path)
  if (!resolvesInsideWorkspace(abs, skill.root ?? workspace)) return null
  let raw: string
  try {
    raw = (await fs.readFile(abs, 'utf8')).trim()
  } catch {
    return null
  }
  if (!raw) return null
  const { body } = parseFrontmatter(raw)
  const text = (body || raw).trim()
  return text || null
}

/**
 * Resolve a `skill({ name })` invocation to the text the model should see: the
 * skill's full instructions, or a helpful "unknown skill" note listing what's
 * available. Name match is case-insensitive. Pure over the loaded skill list, so
 * the loop can inject it as ToolContext.useSkill and it's unit-testable on its own.
 */
export async function resolveSkillInstructions(
  workspace: string,
  skills: Skill[],
  name: string
): Promise<string> {
  const skill = findSkill(skills, name)
  if (!skill) {
    const available = skills.map((s) => s.name).join(', ') || '(none defined for this project)'
    return `Unknown skill: "${name}". Available skills: ${available}.`
  }
  const body = await loadSkillBody(workspace, skill)
  if (body === null) return `Skill "${skill.name}" has no readable instructions.`
  const tail: string[] = []
  if (skill.compatibility) tail.push(`Compatibility: ${skill.compatibility}`)
  if (skill.allowedTools?.length) {
    tail.push(
      `While this skill is active (the rest of this turn), only these tools run: ${skill.allowedTools.join(' ')}. Other tool calls are refused.`
    )
  }
  // List the bundled files after the instructions so the agent knows what it can
  // reach for (read or run), without paying to inline them up front.
  if (skill.resources?.length) {
    const list = skill.resources.map((r) => `- ${r}`).join('\n')
    tail.push(`Bundled files for this skill (read or run with the file tools as the instructions direct):\n${list}`)
  }
  return tail.length ? `${body}\n\n---\n${tail.join('\n\n')}` : body
}

/**
 * Skills whose `paths:` globs match a file one of `calls` works on, each at most once:
 * a skill already in `noted` is skipped, and every match is added to it. Paths
 * outside the workspace never match.
 */
export function pathTriggeredSkills(
  skills: readonly Skill[],
  workspace: string,
  calls: ReadonlyArray<NonNullable<ChatMessage['toolCalls']>[number]>,
  noted: Set<string>
): Array<{ name: string; description: string; file: string }> {
  const out: Array<{ name: string; description: string; file: string }> = []
  const files = calls
    .flatMap((c) => touchedFilePaths(c))
    .map((p) => workspaceRelative(workspace, p))
    .filter((p): p is string => p !== null)
  if (!files.length) return out
  for (const s of skills) {
    if (!s.paths?.length || noted.has(s.name.toLowerCase())) continue
    const file = files.find((f) => skillMatchesPath(s.paths!, f))
    if (!file) continue
    noted.add(s.name.toLowerCase())
    out.push({ name: s.name, description: s.description, file })
  }
  return out
}

/** A loaded skill by name (case-insensitive), or undefined. */
export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  const wanted = name.trim().toLowerCase()
  return skills.find((s) => s.name.toLowerCase() === wanted)
}

/**
 * The template that `/<skill-name>` runs: Houston's own words asking the agent to
 * load the skill and apply it, with whatever the user typed after the name appended.
 * The skill's description (repository text) is never part of it.
 */
export function skillCommandTemplate(name: string): string {
  return `Use the "${name}" skill for this request: load its instructions with the skill tool, then follow them.`
}

/**
 * Slash commands for the loaded skills (`/<skill-name>`), for the command menus.
 * Only names that are safe as a command (letters, digits, `-`, `_`) are offered, and
 * never a built-in skill's name.
 */
export function skillCommands(skills: readonly Skill[]): Command[] {
  const reserved = new Set(BUILTIN_SKILLS.map((s) => s.name.toLowerCase()))
  return skills
    .filter((s) => /^[A-Za-z0-9][\w-]{0,63}$/.test(s.name) && !reserved.has(s.name.toLowerCase()))
    .map((s) => ({
      name: s.name,
      description: s.description.slice(0, 80),
      template: skillCommandTemplate(s.name),
      autoRun: true,
      skill: true
    }))
}
