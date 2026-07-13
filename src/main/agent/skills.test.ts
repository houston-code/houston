import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  BUILTIN_SKILLS,
  withBuiltinSkills,
  loadSkillBody,
  resolveSkillInstructions,
  type Skill
} from './skills'
import { HOUSTON_GUIDE } from './guide-content'

const here = dirname(fileURLToPath(import.meta.url))
const guidePath = resolve(here, '../../../docs/houston-guide.md')

describe('houston-guide built-in skill', () => {
  it('is compiled in from docs/houston-guide.md (regenerate with `npm run gen:guide`)', () => {
    const md = readFileSync(guidePath, 'utf8').trim()
    // If this fails, docs/houston-guide.md changed but guide-content.ts is stale.
    expect(HOUSTON_GUIDE).toBe(md)
  })

  it('ships as a built-in with an in-memory body and a self-describing description', () => {
    const guide = BUILTIN_SKILLS.find((s) => s.name === 'houston-guide')
    expect(guide).toBeDefined()
    expect(guide!.body).toBe(HOUSTON_GUIDE)
    expect(guide!.description.toLowerCase()).toContain('houston')
  })

  it('serves its body from memory without touching the workspace', async () => {
    const guide = BUILTIN_SKILLS[0]
    // Pass a nonexistent workspace: a body-backed skill must not read the disk.
    const body = await loadSkillBody('/no/such/workspace', guide)
    expect(body).toBe(HOUSTON_GUIDE)
  })
})

describe('withBuiltinSkills', () => {
  it('adds the built-ins to a workspace skill list, sorted by name', () => {
    const workspace: Skill[] = [{ name: 'zebra', description: 'z', path: 'a' }]
    const merged = withBuiltinSkills(workspace)
    expect(merged.map((s) => s.name)).toEqual(['houston-guide', 'zebra'])
  })

  it('lets a built-in win a name collision (a workspace cannot shadow it)', () => {
    const workspace: Skill[] = [
      { name: 'houston-guide', description: 'impostor', path: '.houston/skills/houston-guide/SKILL.md' }
    ]
    const merged = withBuiltinSkills(workspace)
    const matches = merged.filter((s) => s.name === 'houston-guide')
    expect(matches).toHaveLength(1)
    expect(matches[0].description).toBe(BUILTIN_SKILLS[0].description)
  })
})

describe('resolveSkillInstructions with the built-in present', () => {
  it('returns the guide body for houston-guide', async () => {
    const skills = withBuiltinSkills([])
    const out = await resolveSkillInstructions('/anywhere', skills, 'Houston-Guide')
    expect(out).toBe(HOUSTON_GUIDE)
  })

  it('still reports unknown skills with the available list', async () => {
    const skills = withBuiltinSkills([])
    const out = await resolveSkillInstructions('/anywhere', skills, 'nope')
    expect(out).toContain('Unknown skill')
    expect(out).toContain('houston-guide')
  })
})
