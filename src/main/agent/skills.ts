import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '@shared/frontmatter'

/**
 * Skills: reusable instruction bundles in `.houston/skills/<name>/SKILL.md`. Each
 * SKILL.md has front-matter `name`/`description` and a body of instructions. Only
 * the name + description are injected into the system prompt (cheap); the agent
 * reads the full SKILL.md with read_file when a task calls for it — progressive
 * disclosure.
 */

export const SKILLS_DIR = '.houston/skills'
const MAX_SKILLS = 50

export interface Skill {
  name: string
  description: string
  /** Workspace-relative path to the skill's instructions, for the agent to read. */
  path: string
}

export async function loadSkills(workspace: string): Promise<Skill[]> {
  let entries
  try {
    entries = await fs.readdir(join(workspace, SKILLS_DIR), { withFileTypes: true })
  } catch {
    return []
  }

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
