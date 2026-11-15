import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { COMMANDS_DIR, loadCommands, loadProjectCommands } from './commands'

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

describe('loadCommands, switched off', () => {
  it('skips a command whose front matter says disabled: true', async () => {
    const home = mkdtempSync(join(tmpdir(), 'houston-cmds-home-'))
    try {
      cmdFile('off.md', '---\ndescription: x\ndisabled: true\n---\nDo it')
      cmdFile('on.md', '---\ndisabled: false\n---\nDo it')
      expect((await loadCommands(workspace, home)).map((c) => c.name)).toEqual(['on'])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('loadCommands, frontmatter options', () => {
  const home = (): string => mkdtempSync(join(tmpdir(), 'houston-cmds-home-'))

  it('reads argument-hint, model, effort, agent and allowed-tools', async () => {
    const h = home()
    try {
      cmdFile(
        'deploy.md',
        '---\ndescription: Ship it\nargument-hint: <env> [version]\nmodel: anthropic/claude-haiku-5-5\neffort: LOW\nagent: deployer\nallowed-tools: read_file, run_shell(npm test*)\n---\nDeploy $1'
      )
      const [cmd] = await loadCommands(workspace, h)
      expect(cmd).toMatchObject({
        name: 'deploy',
        args: '<env> [version]',
        model: 'anthropic/claude-haiku-5-5',
        effort: 'low',
        agent: 'deployer',
        allowedTools: 'read_file, run_shell(npm test*)',
        source: 'project'
      })
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('drops an unknown effort and a malformed agent name, and reads a one-line list', async () => {
    const h = home()
    try {
      cmdFile('x.md', '---\neffort: maximum\nagent: ../evil\nallowed-tools: [read_file, glob]\n---\nGo')
      const [cmd] = await loadCommands(workspace, h)
      expect(cmd.effort).toBeUndefined()
      expect(cmd.agent).toBeUndefined()
      expect(cmd.allowedTools).toBe('read_file, glob')
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })

  it('tags where each command came from', async () => {
    const h = home()
    try {
      cmdFile('mine.md', 'project one')
      mkdirSync(join(h, '.houston/commands'), { recursive: true })
      writeFileSync(join(h, '.houston/commands', 'theirs.md'), 'user one')
      const cmds = await loadCommands(workspace, h)
      expect(cmds.map((c) => [c.name, c.source])).toEqual([
        ['mine', 'project'],
        ['theirs', 'user']
      ])
    } finally {
      rmSync(h, { recursive: true, force: true })
    }
  })
})

describe('loadCommands, namespace folders', () => {
  const nested = (rel: string, content: string): void => {
    const path = join(workspace, COMMANDS_DIR, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'houston-cmds-home-'))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('names a command in a subfolder namespace:name, nesting up to three levels', async () => {
    nested('top.md', 'top level')
    nested('git/commit.md', '---\ndescription: Commit the work\n---\nCommit it.')
    nested('git/pr/open.md', 'open a PR')
    nested('a/b/c/too-deep.md', 'ignored')
    const userDir = join(home, '.houston', 'commands', 'mine')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'note.md'), 'a personal one')
    const cmds = await loadCommands(workspace, home)
    expect(cmds.map((c) => c.name)).toEqual(['git:commit', 'git:pr:open', 'mine:note', 'top'])
    expect(cmds.find((c) => c.name === 'git:commit')).toMatchObject({ description: 'Commit the work', source: 'project' })
    expect(cmds.find((c) => c.name === 'mine:note')).toMatchObject({ source: 'user' })
  })

  it('skips folders and files whose names are not plain words', async () => {
    nested('bad dir/x.md', 'spaced folder')
    nested('dot.dir/x.md', 'dotted folder')
    nested('ok/bad name.md', 'spaced file')
    nested('ok/fine.md', 'fine')
    expect((await loadCommands(workspace, home)).map((c) => c.name)).toEqual(['ok:fine'])
  })

  it('does not follow a symlinked folder out of the repository', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'houston-cmds-outside-'))
    try {
      writeFileSync(join(outside, 'leak.md'), 'from outside the repo')
      nested('real.md', 'real')
      symlinkSync(outside, join(workspace, COMMANDS_DIR, 'linked'), 'dir')
      expect((await loadCommands(workspace, home)).map((c) => c.name)).toEqual(['real'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('a project command wins over the same namespaced user command', async () => {
    nested('git/commit.md', 'project version')
    const userDir = join(home, '.houston', 'commands', 'git')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'commit.md'), 'user version')
    const cmds = await loadCommands(workspace, home)
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toMatchObject({ name: 'git:commit', template: 'project version', source: 'project' })
  })

  it('a project fingerprint covers a namespaced command (loadProjectCommands walks the folders)', async () => {
    nested('ops/deploy.md', '---\nallowed-tools: run_shell\n---\nDeploy.')
    expect((await loadProjectCommands(workspace)).map((c) => [c.name, c.allowedTools])).toEqual([['ops:deploy', 'run_shell']])
  })
})
