import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  BUILTIN_SKILLS,
  withBuiltinSkills,
  loadSkills,
  loadSkillBody,
  resolveSkillInstructions,
  type Skill
} from './skills'
import { HOUSTON_GUIDE } from './guide-content'

/** Run `fn` against a throwaway workspace, cleaned up afterward. */
async function withWorkspace(fn: (ws: string) => Promise<void>): Promise<void> {
  const ws = mkdtempSync(join(tmpdir(), 'houston-skills-'))
  try {
    await fn(ws)
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
}

const SKILL_MD = (name: string, body = 'body'): string =>
  `---\nname: ${name}\ndescription: d\n---\n${body}`

const here = dirname(fileURLToPath(import.meta.url))
const guidePath = resolve(here, '../../../docs/houston-guide.md')

describe('houston-guide built-in skill', () => {
  it('is compiled in from docs/houston-guide.md', () => {
    const md = readFileSync(guidePath, 'utf8').trim()
    // guide-content.ts is generated, not committed, and Vitest's globalSetup
    // regenerates it before this file is imported — so a stale constant is no
    // longer possible and this no longer guards against one. What it still
    // catches is a broken generator: wrong source path, mangled escaping, or a
    // globalSetup that silently stopped running.
    expect(HOUSTON_GUIDE).toBe(md)
    expect(HOUSTON_GUIDE.length).toBeGreaterThan(0)
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

describe('loadSkills — bundled resources', () => {
  it('collects the skill directory\'s non-SKILL.md files, recursively and sorted', async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/demo')
      mkdirSync(join(dir, 'references'), { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('demo'))
      writeFileSync(join(dir, 'template.txt'), 'x')
      writeFileSync(join(dir, 'references', 'api.md'), 'y')
      const skills = await loadSkills(ws)
      const demo = skills.find((s) => s.name === 'demo')
      expect(demo?.resources).toEqual([
        '.houston/skills/demo/references/api.md',
        '.houston/skills/demo/template.txt'
      ])
    })
  })

  it('omits resources when the directory holds only SKILL.md', async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/plain')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('plain'))
      const skills = await loadSkills(ws)
      expect(skills.find((s) => s.name === 'plain')?.resources).toBeUndefined()
    })
  })

  it('lists the bundled files after the instructions in the skill tool response', async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('demo', 'Do the thing.'))
      writeFileSync(join(dir, 'helper.py'), 'print(1)')
      const skills = await loadSkills(ws)
      const out = await resolveSkillInstructions(ws, skills, 'demo')
      expect(out).toContain('Do the thing.')
      expect(out).toContain('Bundled files for this skill')
      expect(out).toContain('.houston/skills/demo/helper.py')
    })
  })

  it('does not append a bundled-files section when there are none', async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/plain')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('plain', 'Just instructions.'))
      const skills = await loadSkills(ws)
      const out = await resolveSkillInstructions(ws, skills, 'plain')
      expect(out).toBe('Just instructions.')
    })
  })
})
