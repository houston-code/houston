import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '@shared/frontmatter'
import { HOUSTON_GUIDE } from './guide-content'

/**
 * Skills: reusable instruction bundles in `.houston/skills/<name>/SKILL.md`. Each
 * SKILL.md has front-matter `name`/`description` and a body of instructions. Only
 * the name + description are injected into the system prompt (cheap); the agent
 * loads the full SKILL.md on demand via the `skill` tool (or read_file the path) —
 * progressive disclosure.
 */

export const SKILLS_DIR = '.houston/skills'
const MAX_SKILLS = 50

export interface Skill {
  name: string
  description: string
  /** Workspace-relative path to the skill's instructions, for the agent to read. */
  path: string
  /**
   * In-memory instructions for a built-in skill (one that ships with Houston
   * rather than living in a workspace file). When set, {@link loadSkillBody}
   * serves this directly instead of reading `path` from the workspace.
   */
  body?: string
}

/**
 * Skills that ship with Houston itself, present in every run regardless of the
 * workspace. `houston-guide` lets the agent answer questions about Houston's own
 * features from an authoritative source instead of guessing (the system prompt
 * points the agent at it). Its body is compiled in via {@link HOUSTON_GUIDE}, so
 * there is no workspace file to read.
 *
 * These are merged into the agent's skill list at the run seam (see
 * {@link withBuiltinSkills}), NOT inside {@link loadSkills} — so the `/skills`
 * command keeps listing only the workspace's own `.houston/skills`.
 */
export const BUILTIN_SKILLS: Skill[] = [
  {
    name: 'houston-guide',
    description:
      "How Houston itself works: its slash commands, skills, subagents, hooks, plugins, MCP servers, approval modes and permission rules, plan mode, sandboxing, GitHub tools, and settings. Load this to answer any question about Houston's own features.",
    path: '(built-in)',
    body: HOUSTON_GUIDE
  }
]

/**
 * Merge Houston's built-in skills with a workspace's loaded skills for the agent
 * runtime. Built-ins win a name collision, so a workspace can't shadow (or
 * silently override) `houston-guide`.
 */
export function withBuiltinSkills(workspaceSkills: Skill[]): Skill[] {
  const reserved = new Set(BUILTIN_SKILLS.map((s) => s.name.toLowerCase()))
  const merged = [...BUILTIN_SKILLS, ...workspaceSkills.filter((s) => !reserved.has(s.name.toLowerCase()))]
  merged.sort((a, b) => a.name.localeCompare(b.name))
  return merged
}

export async function loadSkills(workspace: string): Promise<Skill[]> {
  let entries
  try {
    entries = await fs.readdir(join(workspace, SKILLS_DIR), { withFileTypes: true })
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
    const rel = `${SKILLS_DIR}/${e.name}/SKILL.md`
    let raw: string
    try {
      raw = (await fs.readFile(join(workspace, rel), 'utf8')).trim()
    } catch {
      continue // a dir without a SKILL.md isn't a skill
    }
    if (!raw) continue
    const { data } = parseFrontmatter(raw)
    skills.push({
      name: data.name || e.name,
      description: data.description || 'No description.',
      path: rel
    })
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
  let raw: string
  try {
    raw = (await fs.readFile(join(workspace, skill.path), 'utf8')).trim()
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
  const wanted = name.trim().toLowerCase()
  const skill = skills.find((s) => s.name.toLowerCase() === wanted)
  if (!skill) {
    const available = skills.map((s) => s.name).join(', ') || '(none defined for this project)'
    return `Unknown skill: "${name}". Available skills: ${available}.`
  }
  const body = await loadSkillBody(workspace, skill)
  return body ?? `Skill "${skill.name}" has no readable instructions.`
}
