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
