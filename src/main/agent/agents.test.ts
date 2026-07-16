import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgents, AGENTS_DIR } from './agents'
import { loadSkills, loadSkillBody, resolveSkillInstructions, SKILLS_DIR } from './skills'
import { buildCapabilities } from './capabilities'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-agents-'))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

function writeAgent(name: string, content: string): void {
  mkdirSync(join(ws, AGENTS_DIR), { recursive: true })
  writeFileSync(join(ws, AGENTS_DIR, `${name}.md`), content)
}
function writeSkill(dir: string, content: string): void {
  mkdirSync(join(ws, SKILLS_DIR, dir), { recursive: true })
  writeFileSync(join(ws, SKILLS_DIR, dir, 'SKILL.md'), content)
}

describe('loadAgents', () => {
  it('returns [] when there is no agents dir', async () => {
    expect(await loadAgents(ws)).toEqual([])
  })

  it('loads an agent with front-matter description and prompt body', async () => {
    writeAgent('security', '---\ndescription: Reviews for vulns\n---\nYou are a security reviewer.')
    const agents = await loadAgents(ws)
    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({
      name: 'security',
      description: 'Reviews for vulns',
      systemPrompt: 'You are a security reviewer.'
    })
  })

  it('falls back to the first body line for the description', async () => {
    writeAgent('explorer', 'Maps the codebase structure.\nMore detail.')
    const [a] = await loadAgents(ws)
    expect(a.description).toBe('Maps the codebase structure.')
  })

  it('ignores non-.md files and bad names', async () => {
    mkdirSync(join(ws, AGENTS_DIR), { recursive: true })
    writeFileSync(join(ws, AGENTS_DIR, 'notes.txt'), 'nope')
    writeFileSync(join(ws, AGENTS_DIR, 'bad name.md'), 'x')
    expect(await loadAgents(ws)).toEqual([])
  })

  it('parses a comma/space separated tools allow-list from front-matter', async () => {
    writeAgent('reader', '---\ntools: read_file, glob list_dir\n---\nYou only read.')
    const [a] = await loadAgents(ws)
    expect(a.tools).toEqual(['read_file', 'glob', 'list_dir'])
  })

  it('leaves tools undefined when the front-matter field is absent', async () => {
    writeAgent('plain', 'Just a prompt, no tools field.')
    const [a] = await loadAgents(ws)
    expect(a.tools).toBeUndefined()
  })

  it('treats an empty tools field as undefined', async () => {
    writeAgent('blank', '---\ntools:\n---\nNo tools listed.')
    const [a] = await loadAgents(ws)
    expect(a.tools).toBeUndefined()
  })

  it('parses `write: true` into a writable agent', async () => {
    writeAgent('builder', '---\ndescription: Implements features\nwrite: true\n---\nYou implement changes.')
    const [a] = await loadAgents(ws)
    expect(a.write).toBe(true)
  })

  it('leaves write undefined by default (read-only)', async () => {
    writeAgent('reader', '---\ndescription: Reads only\n---\nYou only read.')
    const [a] = await loadAgents(ws)
    expect(a.write).toBeUndefined()
  })

  it('treats a falsey write flag as read-only', async () => {
    writeAgent('reader2', '---\nwrite: false\n---\nStill read-only.')
    const [a] = await loadAgents(ws)
    expect(a.write).toBeUndefined()
  })
})

describe('loadSkills', () => {
  it('loads skills from SKILL.md with name + description', async () => {
    writeSkill('pdf', '---\nname: PDF tools\ndescription: Work with PDFs\n---\nDetailed instructions...')
    const skills = await loadSkills(ws)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'PDF tools',
      description: 'Work with PDFs',
      path: `${SKILLS_DIR}/pdf/SKILL.md`
    })
  })

  it('skips directories without a SKILL.md', async () => {
    mkdirSync(join(ws, SKILLS_DIR, 'empty'), { recursive: true })
    expect(await loadSkills(ws)).toEqual([])
  })
})

describe('loadSkillBody', () => {
  it('returns the SKILL.md body with front-matter stripped', async () => {
    writeSkill('pdf', '---\nname: PDF tools\ndescription: Work with PDFs\n---\nStep 1. Do the thing.\nStep 2. Done.')
    const [skill] = await loadSkills(ws)
    expect(await loadSkillBody(ws, skill)).toBe('Step 1. Do the thing.\nStep 2. Done.')
  })

  it('returns null when the instructions file is gone', async () => {
    expect(await loadSkillBody(ws, { name: 'x', description: 'y', path: `${SKILLS_DIR}/x/SKILL.md` })).toBeNull()
  })
})

describe('resolveSkillInstructions', () => {
  it('returns a known skill\'s instructions (case-insensitive name)', async () => {
    writeSkill('pdf', '---\nname: PDF tools\ndescription: Work with PDFs\n---\nFull instructions here.')
    const skills = await loadSkills(ws)
    expect(await resolveSkillInstructions(ws, skills, 'pdf tools')).toBe('Full instructions here.')
  })

  it('reports the available skills when the name is unknown', async () => {
    writeSkill('pdf', '---\nname: PDF tools\ndescription: Work with PDFs\n---\nx')
    const skills = await loadSkills(ws)
    const out = await resolveSkillInstructions(ws, skills, 'spreadsheets')
    expect(out).toContain('Unknown skill')
    expect(out).toContain('PDF tools')
  })

  it('notes when there are no skills at all', async () => {
    expect(await resolveSkillInstructions(ws, [], 'anything')).toContain('none defined')
  })
})

describe('buildCapabilities', () => {
  it('is empty with nothing to advertise', () => {
    expect(buildCapabilities([], [])).toBe('')
  })

  it('lists agents and skills', () => {
    const text = buildCapabilities(
      [{ name: 'sec', description: 'security', systemPrompt: '...' }],
      [{ name: 'pdf', description: 'pdfs', path: '.houston/skills/pdf/SKILL.md' }]
    )
    expect(text).toContain('dispatch_agent')
    expect(text).toContain('sec: security')
    expect(text).toContain('.houston/skills/pdf/SKILL.md')
    expect(text).toContain('skill({')
  })
})

describe('agent front-matter model', () => {
  it('parses a front-matter model into the agent', async () => {
    writeAgent('scout', '---\ndescription: cheap scout\nmodel: haiku-mini\n---\nYou scout.')
    const [a] = await loadAgents(ws)
    expect(a.model).toBe('haiku-mini')
  })

  it('leaves model undefined when absent or blank', async () => {
    writeAgent('plain', '---\ndescription: d\n---\nBody.')
    writeAgent('blank', '---\nmodel:   \n---\nBody.')
    const agents = await loadAgents(ws)
    for (const a of agents) expect(a.model).toBeUndefined()
  })
})

describe('buildCapabilities: dispatch models', () => {
  it('advertises the provider model ids for dispatch overrides (only when there is a choice)', () => {
    const text = buildCapabilities([], [], ['claude-test', 'cheap-model'])
    expect(text).toContain('claude-test, cheap-model')
    expect(text).toContain('`model` override')
    // A single-model provider offers no choice, so the section is dropped.
    expect(buildCapabilities([], [], ['claude-test'])).toBe('')
    expect(buildCapabilities([], [])).toBe('')
  })

  it("tags an agent that pins its own model in the agent listing", async () => {
    writeAgent('scout', '---\ndescription: cheap scout\nmodel: haiku-mini\n---\nYou scout.')
    const agents = await loadAgents(ws)
    const text = buildCapabilities(agents, [])
    expect(text).toContain('[runs on haiku-mini]')
  })
})
