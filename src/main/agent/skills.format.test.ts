import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findSkill,
  loadSkills,
  pathTriggeredSkills,
  resolveSkillInstructions,
  skillCommandTemplate,
  skillCommands,
  type Skill
} from './skills'
import { loadSlashCommands } from './commands'
import { commandTurn } from '@shared/promptInvocation'
import { commandGroup, SKILL_COMMAND_GROUP } from '@shared/commands'

const made: string[] = []
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  made.push(d)
  return d
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

function skill(root: string, rel: string, name: string, fm: string, body = 'Do the thing.'): void {
  const dir = join(root, rel, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\n${fm}\n---\n${body}\n`)
}

describe('.agents/skills', () => {
  it('reads the project and user .agents/skills folders with the format fields', async () => {
    const ws = tmp('houston-ws-')
    const home = tmp('houston-home-')
    skill(
      ws,
      '.agents/skills',
      'pdf-tools',
      'name: pdf-tools\ndescription: PDFs.\nlicense: MIT\nallowed-tools: Read\npaths: "*.pdf"\nmetadata:\n  author: me'
    )
    skill(home, '.agents/skills', 'mine', 'name: mine\ndescription: Mine.')
    const skills = await loadSkills(ws, home)
    expect(skills.map((s) => s.name)).toEqual(['mine', 'pdf-tools'])
    const pdf = findSkill(skills, 'PDF-tools')!
    expect(pdf).toMatchObject({
      path: '.agents/skills/pdf-tools/SKILL.md',
      source: 'agents',
      license: 'MIT',
      allowedTools: ['Read'],
      paths: ['*.pdf'],
      metadata: { author: 'me' }
    })
    expect(findSkill(skills, 'mine')!.root).toBe(join(home, '.agents', 'skills'))
  })

  it('does not load an .agents skill that breaks the format, but keeps a legacy .houston one', async () => {
    const ws = tmp('houston-ws-')
    const home = tmp('houston-home-')
    skill(ws, '.agents/skills', 'Bad_Name', 'name: Bad_Name\ndescription: d')
    skill(ws, '.agents/skills', 'folder', 'name: other\ndescription: d')
    skill(ws, '.agents/skills', 'nodesc', 'name: nodesc')
    skill(ws, '.houston/skills', 'Legacy_One', 'name: Legacy_One')
    const names = (await loadSkills(ws, home)).map((s) => s.name)
    expect(names).toEqual(['Legacy_One'])
  })

  it('prefers project over user, and .houston over .agents in each place', async () => {
    const ws = tmp('houston-ws-')
    const home = tmp('houston-home-')
    skill(ws, '.houston/skills', 'deploy', 'name: deploy\ndescription: project houston')
    skill(ws, '.agents/skills', 'deploy', 'name: deploy\ndescription: project agents')
    skill(ws, '.agents/skills', 'lint', 'name: lint\ndescription: project agents')
    skill(home, '.houston/skills', 'lint', 'name: lint\ndescription: user houston')
    skill(home, '.houston/skills', 'docs', 'name: docs\ndescription: user houston')
    skill(home, '.agents/skills', 'docs', 'name: docs\ndescription: user agents')
    const byName = Object.fromEntries((await loadSkills(ws, home)).map((s) => [s.name, s.description]))
    expect(byName).toEqual({ deploy: 'project houston', lint: 'project agents', docs: 'user houston' })
  })

  it('never reads .claude/skills natively', async () => {
    const ws = tmp('houston-ws-')
    skill(ws, '.claude/skills', 'imported', 'name: imported\ndescription: d')
    expect(await loadSkills(ws, tmp('houston-home-'))).toEqual([])
  })
})

describe('skill instructions', () => {
  it('say which tools the skill limits the turn to, and its compatibility note', async () => {
    const ws = tmp('houston-ws-')
    skill(ws, '.agents/skills', 'ro', 'name: ro\ndescription: d\ncompatibility: Needs git\nallowed-tools: Read Grep')
    const skills = await loadSkills(ws, tmp('houston-home-'))
    const text = await resolveSkillInstructions(ws, skills, 'ro')
    expect(text).toContain('Do the thing.')
    expect(text).toContain('Compatibility: Needs git')
    expect(text).toContain('only these tools run: Read Grep')
  })
})

describe('/<skill-name>', () => {
  const s = (name: string): Skill => ({ name, description: `About ${name}`, path: `.agents/skills/${name}/SKILL.md` })

  it('offers a command per skill that runs as an invoked turn in Houston\'s own words', () => {
    const [cmd] = skillCommands([s('pdf-tools')])
    expect(cmd).toMatchObject({ name: 'pdf-tools', autoRun: true, skill: true })
    expect(commandGroup(cmd)).toBe(SKILL_COMMAND_GROUP)
    const turn = commandTurn(cmd, 'split report.pdf', '/pdf-tools split report.pdf')!
    expect(turn.text).toBe(`${skillCommandTemplate('pdf-tools')}\n\nsplit report.pdf`)
    expect(turn.text).not.toContain('About pdf-tools')
    expect(turn.invokedAs).toEqual({
      kind: 'command',
      label: '/pdf-tools',
      detail: 'About pdf-tools',
      typed: '/pdf-tools split report.pdf'
    })
  })

  it('skips names that are not safe as a command, and the built-in skills', () => {
    expect(skillCommands([s('My Skill'), s('houston-guide'), s('$1'), s('ok_name')]).map((c) => c.name)).toEqual([
      'ok_name'
    ])
  })

  it('lists skills after custom commands, which win a name clash', async () => {
    const ws = tmp('houston-ws-')
    const home = tmp('houston-home-')
    mkdirSync(join(ws, '.houston', 'commands'), { recursive: true })
    writeFileSync(join(ws, '.houston', 'commands', 'deploy.md'), 'Deploy it.')
    skill(ws, '.agents/skills', 'deploy', 'name: deploy\ndescription: d')
    skill(ws, '.agents/skills', 'lint', 'name: lint\ndescription: Lint things.')
    const cmds = await loadSlashCommands(ws, home)
    expect(cmds.map((c) => [c.name, c.skill === true])).toEqual([
      ['deploy', false],
      ['lint', true]
    ])
  })
})

describe('paths triggers', () => {
  const ws = join('/', 'repo')
  const skills: Skill[] = [
    { name: 'pdf', description: 'PDFs.', path: 'p', paths: ['*.pdf'] },
    { name: 'sql', description: 'SQL.', path: 'p', paths: ['migrations/**'] },
    { name: 'none', description: 'No paths.', path: 'p' }
  ]
  const call = (name: string, args: Record<string, unknown>): { id: string; name: string; arguments: Record<string, unknown> } => ({
    id: 'c',
    name,
    arguments: args
  })

  it('surfaces a skill once when a file tool touches a match', () => {
    const noted = new Set<string>()
    const first = pathTriggeredSkills(skills, ws, [call('read_file', { path: 'docs/a.pdf' })], noted)
    expect(first).toEqual([{ name: 'pdf', description: 'PDFs.', file: 'docs/a.pdf' }])
    expect(pathTriggeredSkills(skills, ws, [call('read_file', { path: 'b.pdf' })], noted)).toEqual([])
  })

  it('reads apply_patch envelopes and absolute paths inside the workspace', () => {
    const patch = '*** Begin Patch\n*** Add File: migrations/001.sql\n+select 1;\n*** End Patch'
    const hits = pathTriggeredSkills(skills, ws, [call('apply_patch', { patch })], new Set())
    expect(hits.map((h) => h.name)).toEqual(['sql'])
    expect(
      pathTriggeredSkills(skills, ws, [call('write_file', { path: join(ws, 'x.pdf') })], new Set()).map((h) => h.name)
    ).toEqual(['pdf'])
  })

  it('ignores other tools and paths outside the workspace', () => {
    expect(pathTriggeredSkills(skills, ws, [call('run_shell', { command: 'cat a.pdf' })], new Set())).toEqual([])
    expect(pathTriggeredSkills(skills, ws, [call('read_file', { path: join('/', 'etc', 'a.pdf') })], new Set())).toEqual(
      []
    )
  })
})
