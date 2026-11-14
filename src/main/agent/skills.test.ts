import { describe, it, expect } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  BUILTIN_SKILLS,
  withBuiltinSkills,
  loadSkills,
  loadSkillBody,
  resolveSkillInstructions,
  resolveSkillFile,
  readSkillFile,
  MAX_SKILL_FILE_BYTES,
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
    expect(merged.map((s) => s.name)).toEqual(['houston-guide', 'render-ui', 'zebra'])
  })

  it('leaves out a built-in whose required tool the run does not offer', () => {
    expect(withBuiltinSkills([], ['read_file', 'show_images']).map((s) => s.name)).toEqual([
      'houston-guide',
      'render-ui'
    ])
    expect(withBuiltinSkills([], ['read_file']).map((s) => s.name)).toEqual(['houston-guide'])
  })

  it('keeps a left-out built-in name reserved, so a workspace skill cannot take it', () => {
    const impostor: Skill[] = [{ name: 'Render-UI', description: 'impostor', path: '.houston/skills/render-ui/SKILL.md' }]
    expect(withBuiltinSkills(impostor, ['read_file']).map((s) => s.name)).toEqual(['houston-guide'])
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

describe('render-ui built-in', () => {
  it('serves its instructions from memory and points at show_images', async () => {
    const skill = BUILTIN_SKILLS.find((s) => s.name === 'render-ui')!
    expect(skill.requiresTools).toEqual(['show_images'])
    const body = await loadSkillBody('/no/such/workspace', skill)
    expect(body).toContain('show_images')
    expect(body).toContain('mockup')
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

describe('skills from outside the workspace', () => {
  // A repo's SKILL.md is attacker-controlled, and the `skill` tool returns its body
  // to the model without asking. A symlink out of the tree must not be followed.
  it('skips a SKILL.md that is a symlink out of the tree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-outside-'))
    try {
      writeFileSync(join(outside, 'secret.md'), SKILL_MD('stolen', 'TOPSECRET-SKILL'))
      await withWorkspace(async (ws) => {
        mkdirSync(join(ws, '.houston/skills/setup'), { recursive: true })
        symlinkSync(join(outside, 'secret.md'), join(ws, '.houston/skills/setup/SKILL.md'))
        mkdirSync(join(ws, '.houston/skills/real'), { recursive: true })
        writeFileSync(join(ws, '.houston/skills/real/SKILL.md'), SKILL_MD('real'))
        expect((await loadSkills(ws)).map((s) => s.name)).toEqual(['real'])
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a SKILL.md swapped for an outside symlink after the list was built', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-outside-'))
    try {
      writeFileSync(join(outside, 'secret.md'), 'TOPSECRET-SWAP')
      await withWorkspace(async (ws) => {
        const file = join(ws, '.houston/skills/setup/SKILL.md')
        mkdirSync(join(ws, '.houston/skills/setup'), { recursive: true })
        writeFileSync(file, SKILL_MD('setup'))
        const [skill] = await loadSkills(ws)
        rmSync(file)
        symlinkSync(join(outside, 'secret.md'), file)
        expect(await loadSkillBody(ws, skill)).toBeNull()
        expect(await resolveSkillInstructions(ws, [skill], 'setup')).not.toContain('TOPSECRET-SWAP')
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
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
      expect(out).toContain('skill({ name: "demo", file: "<path>" })')
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

describe('skill({ name, file }): bundled files', () => {
  /** A workspace and a separate home folder, both thrown away afterward. */
  async function withHome(fn: (ws: string, home: string) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), 'houston-home-'))
    try {
      await withWorkspace((ws) => fn(ws, home))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  it("reads a user skill's file by the absolute path it is listed under, though it is outside the project", async () => {
    await withHome(async (ws, home) => {
      const dir = join(home, '.houston/skills/deploy')
      mkdirSync(join(dir, 'references'), { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('deploy', 'See references/steps.md.'))
      writeFileSync(join(dir, 'references', 'steps.md'), 'Step 1: build.')
      const skills = await loadSkills(ws, home)
      const deploy = skills.find((s) => s.name === 'deploy')!
      const listed = deploy.resources![0]
      expect(listed).toBe(join(dir, 'references', 'steps.md'))
      expect(await resolveSkillFile(ws, skills, 'deploy', listed)).toBe('Step 1: build.')
      // Relative to the skill folder works too, with or without ./
      expect(await resolveSkillFile(ws, skills, 'Deploy', 'references/steps.md')).toBe('Step 1: build.')
      expect(await resolveSkillFile(ws, skills, 'deploy', './references/steps.md')).toBe('Step 1: build.')
    })
  })

  it("reads a project skill's file by its workspace-relative listed path", async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('demo'))
      writeFileSync(join(dir, 'helper.py'), 'print(1)\n')
      const skills = await loadSkills(ws)
      expect(await resolveSkillFile(ws, skills, 'demo', '.houston/skills/demo/helper.py')).toBe('print(1)\n')
      expect(await resolveSkillFile(ws, skills, 'demo', 'helper.py')).toBe('print(1)\n')
    })
  })

  it('refuses paths that leave the skill folder', async () => {
    await withHome(async (ws, home) => {
      const dir = join(home, '.houston/skills/deploy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('deploy'))
      writeFileSync(join(home, '.houston/skills/other.txt'), 'NEIGHBOUR')
      writeFileSync(join(home, 'secret.txt'), 'TOPSECRET')
      const skills = await loadSkills(ws, home)
      for (const file of ['../other.txt', '../../secret.txt', join(home, 'secret.txt'), '/etc/hosts', 'a/../../x', 'x\u0000y']) {
        const out = await resolveSkillFile(ws, skills, 'deploy', file)
        expect(out).toMatch(/is not a file inside skill "deploy"/)
        expect(out).not.toContain('TOPSECRET')
        expect(out).not.toContain('NEIGHBOUR')
      }
    })
  })

  it('refuses a symlink inside the skill folder that points outside it', async () => {
    await withHome(async (ws, home) => {
      const dir = join(home, '.houston/skills/deploy')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('deploy'))
      writeFileSync(join(home, 'secret.txt'), 'TOPSECRET')
      symlinkSync(join(home, 'secret.txt'), join(dir, 'notes.md'))
      const skills = await loadSkills(ws, home)
      const out = await resolveSkillFile(ws, skills, 'deploy', 'notes.md')
      expect(out).not.toContain('TOPSECRET')
      expect(out).toMatch(/is not a file inside skill/)
    })
  })

  it('follows a symlink that stays inside the skill folder', async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/demo')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('demo'))
      writeFileSync(join(dir, 'real.md'), 'REAL')
      symlinkSync(join(dir, 'real.md'), join(dir, 'alias.md'))
      expect(await resolveSkillFile(ws, await loadSkills(ws), 'demo', 'alias.md')).toBe('REAL')
    })
  })

  it('refuses credential-looking files, directories, binaries and oversized files', async () => {
    await withWorkspace(async (ws) => {
      const dir = join(ws, '.houston/skills/demo')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('demo'))
      writeFileSync(join(dir, '.env'), 'API_KEY=sk-live-123')
      writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
      writeFileSync(join(dir, 'big.txt'), 'x'.repeat(MAX_SKILL_FILE_BYTES + 1))
      const skills = await loadSkills(ws)
      const env = await resolveSkillFile(ws, skills, 'demo', '.env')
      expect(env).toMatch(/looks like a credentials file/)
      expect(env).not.toContain('sk-live')
      expect(await resolveSkillFile(ws, skills, 'demo', 'sub')).toMatch(/is not a file/)
      expect(await resolveSkillFile(ws, skills, 'demo', 'logo.png')).toMatch(/is a binary file \(8 bytes\)/)
      expect(await resolveSkillFile(ws, skills, 'demo', 'big.txt')).toMatch(/over the 262144-byte limit/)
      expect(await resolveSkillFile(ws, skills, 'demo', 'missing.md')).toMatch(/is not a file inside skill/)
    })
  })

  it('refuses when the skill folder itself was swapped for a link out of its root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-outside-'))
    try {
      writeFileSync(join(outside, 'loot.md'), 'TOPSECRET')
      await withWorkspace(async (ws) => {
        const dir = join(ws, '.houston/skills/demo')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'SKILL.md'), SKILL_MD('demo'))
        const skills = await loadSkills(ws)
        rmSync(dir, { recursive: true })
        symlinkSync(outside, dir)
        const out = await resolveSkillFile(ws, skills, 'demo', 'loot.md')
        expect(out).not.toContain('TOPSECRET')
      })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('says a built-in skill has no files, and lists skills for an unknown name', async () => {
    const skills = withBuiltinSkills([])
    expect(await readSkillFile('/anywhere', skills.find((s) => s.name === 'houston-guide')!, 'x.md')).toMatch(
      /built in and has no bundled files/
    )
    expect(await resolveSkillFile('/anywhere', skills, 'nope', 'x.md')).toMatch(/Unknown skill: "nope"/)
  })
})
