import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgents, AGENTS_DIR } from './agents'
import { loadSkills, SKILLS_DIR } from './skills'
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
  })
})
