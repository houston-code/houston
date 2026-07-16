import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMMANDS_DIR, loadCommands } from './commands'

let workspace: string
const cmdFile = (name: string, content: string): void => {
  const dir = join(workspace, COMMANDS_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content)
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'houston-cmds-'))
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('loadCommands', () => {
  it('returns [] when there is no commands dir', async () => {
    expect(await loadCommands(workspace)).toEqual([])
  })

  it('loads .md commands with name + first-line description + template', async () => {
    cmdFile('review.md', '# Review the diff\nLook for bugs in $ARGUMENTS.')
    const cmds = await loadCommands(workspace)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({
      name: 'review',
      description: 'Review the diff',
      template: '# Review the diff\nLook for bugs in $ARGUMENTS.'
    })
  })

  it('ignores non-md files, empty files, and unsafe names', async () => {
    cmdFile('notes.txt', 'nope')
    cmdFile('empty.md', '   ')
    cmdFile('bad name.md', 'has a space')
    cmdFile('good.md', 'fine')
    expect((await loadCommands(workspace)).map((c) => c.name)).toEqual(['good'])
  })

  it('sorts commands by name', async () => {
    cmdFile('zeta.md', 'z')
    cmdFile('alpha.md', 'a')
    expect((await loadCommands(workspace)).map((c) => c.name)).toEqual(['alpha', 'zeta'])
  })
})

describe('loadCommands — frontmatter and user scope', () => {
  function dir(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'houston-cmds-'))
    mkdirSync(join(root, '.houston/commands'), { recursive: true })
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(root, '.houston/commands', name), body)
    }
    return root
  }

  it('takes the description from frontmatter, keeping it out of the prompt', async () => {
    const ws = dir({ 'ship.md': '---\ndescription: Ship it to staging\n---\nDeploy the branch and report.' })
    const [cmd] = await loadCommands(ws, ws)
    expect(cmd.description).toBe('Ship it to staging')
    // The menu sentence must not be part of what the model reads.
    expect(cmd.template).toBe('Deploy the branch and report.')
    expect(cmd.template).not.toContain('Ship it to staging')
  })

  it('still uses the first line when there is no frontmatter', async () => {
    const ws = dir({ 'old.md': '# Review the diff\nDo the thing.' })
    const [cmd] = await loadCommands(ws, ws)
    expect(cmd.description).toBe('Review the diff')
    expect(cmd.template).toContain('Do the thing.')
  })

  // A command you want in EVERY project had to be copied into every repo.
  it('loads the user’s own commands from their home dir', async () => {
    const ws = dir({})
    const home = dir({ 'mine.md': '---\ndescription: My checklist\n---\nCheck everything.' })
    const names = (await loadCommands(ws, home)).map((c) => c.name)
    expect(names).toContain('mine')
  })

  it('merges both scopes', async () => {
    const ws = dir({ 'proj.md': 'Project one' })
    const home = dir({ 'mine.md': 'Personal one' })
    expect((await loadCommands(ws, home)).map((c) => c.name)).toEqual(['mine', 'proj'])
  })

  // A personal command silently overriding a project's own /review would be a
  // nasty surprise in someone else's repo.
  it('lets the project win a name collision', async () => {
    const ws = dir({ 'review.md': 'The project way' })
    const home = dir({ 'review.md': 'My way' })
    const cmds = await loadCommands(ws, home)
    expect(cmds).toHaveLength(1)
    expect(cmds[0].template).toBe('The project way')
  })

  it('skips a command that is only frontmatter', async () => {
    const ws = dir({ 'empty.md': '---\ndescription: nothing\n---\n' })
    expect(await loadCommands(ws, ws)).toHaveLength(0)
  })
})
