import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { McpServerConfig } from '@shared/types'
import { hasNewImportables, importSelected, rulesMarker, scanImportables, withImportedRules, type ImportDeps } from './importConfig'
import { LEGACY_RULES_IMPORT, globalRulesFile } from './globalRules'

let home: string
let ws: string
let userServers: McpServerConfig[]
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'houston-imphome-'))
  ws = mkdtempSync(join(tmpdir(), 'houston-impws-'))
  userServers = []
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

function put(root: string, rel: string, text: string): string {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text)
  return abs
}

function deps(over: Partial<ImportDeps> = {}): ImportDeps {
  return {
    home,
    workspace: ws,
    platform: 'linux',
    env: {},
    userMcpServers: () => userServers,
    addUserMcpServers: (servers) => {
      userServers = [...userServers, ...servers]
      return { mcpServers: userServers } as never
    },
    ...over
  }
}

async function ids(over: Partial<ImportDeps> = {}): Promise<string[]> {
  return (await scanImportables(deps(over))).candidates.map((c) => c.id)
}

describe('scanImportables', () => {
  it('finds nothing in empty folders', async () => {
    expect(await ids()).toEqual([])
    expect(await hasNewImportables(deps())).toBe(false)
  })

  it('finds instruction files, servers, skills and commands in the home folder and the project', async () => {
    put(home, '.codex/AGENTS.md', 'Use tabs.')
    put(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { git: { command: 'uvx', args: ['mcp-server-git'] } } }))
    put(home, '.claude/commands/review.md', '---\ndescription: Review the diff\n---\nReview $ARGUMENTS')
    put(ws, 'GEMINI.md', 'Project rule.')
    put(ws, '.mcp.json', JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
    put(ws, '.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Ship it\n---\nSteps')
    put(ws, '.claude/skills/deploy/notes/a.txt', 'note')
    put(ws, '.claude/commands/fix.md', 'Fix the bug')
    const scan = await scanImportables(deps())
    const byId = Object.fromEntries(scan.candidates.map((c) => [c.id, c]))
    expect(Object.keys(byId).sort()).toEqual(
      [
        'command:project:.claude/commands/fix.md',
        'command:user:~/.claude/commands/review.md',
        'mcp:project:.mcp.json:db',
        'mcp:user:~/.cursor/mcp.json:git',
        'rules:project:GEMINI.md',
        'rules:user:~/.codex/AGENTS.md',
        'skill:project:.claude/skills/deploy'
      ].sort()
    )
    expect(byId['mcp:user:~/.cursor/mcp.json:git']).toMatchObject({ detail: 'uvx mcp-server-git', status: 'new' })
    expect(byId['command:user:~/.claude/commands/review.md']).toMatchObject({
      name: '/review',
      detail: 'Review the diff',
      target: '~/.houston/commands/review.md'
    })
    expect(byId['skill:project:.claude/skills/deploy']).toMatchObject({ name: 'deploy', target: '.houston/skills/deploy' })
    // No internals (the server config, the copy function) leave main.
    expect(Object.keys(byId['mcp:user:~/.cursor/mcp.json:git'])).not.toContain('server')
    expect(await hasNewImportables(deps())).toBe(true)
  })

  it("reads a file's top-level servers and the open project's own entry", async () => {
    put(
      home,
      '.claude.json',
      JSON.stringify({
        mcpServers: { top: { command: 'a' } },
        projects: { [ws]: { mcpServers: { mine: { command: 'b' } } }, '/other': { mcpServers: { theirs: { command: 'c' } } } }
      })
    )
    expect(await ids()).toEqual(['mcp:user:~/.claude.json:top', 'mcp:user:~/.claude.json:mine'])
  })

  it('reads the desktop app list from the platform folder', async () => {
    put(home, 'Library/Application Support/Claude/claude_desktop_config.json', JSON.stringify({ mcpServers: { m: { command: 'x' } } }))
    expect(await ids({ platform: 'darwin' })).toEqual(['mcp:user:~/Library/Application Support/Claude/claude_desktop_config.json:m'])
    expect(await ids({ platform: 'linux' })).toEqual([])
  })

  it('marks what Houston already has as present', async () => {
    userServers = [{ id: 'git', command: 'other', enabled: true }]
    put(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { git: { command: 'uvx' } } }))
    put(home, '.claude/commands/review.md', 'x')
    put(home, '.houston/commands/review.md', 'mine')
    const scan = await scanImportables(deps())
    expect(scan.candidates.map((c) => [c.status, c.note])).toEqual([
      ['present', 'Houston already has a server named git'],
      ['present', 'Houston already has /review']
    ])
  })

  it('marks a second find with the same name as present', async () => {
    put(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { git: { command: 'a' } } }))
    put(home, '.gemini/settings.json', JSON.stringify({ theme: 'x', mcpServers: { git: { command: 'b' } } }))
    const scan = await scanImportables(deps())
    expect(scan.candidates.map((c) => c.status)).toEqual(['new', 'present'])
    expect(scan.candidates[1].note).toBe('Also found in ~/.cursor/mcp.json')
  })

  it('skips project files and folders that link outside the project', async () => {
    const secret = put(home, 'secret.md', 'private')
    symlinkSync(secret, join(ws, 'GEMINI.md'))
    mkdirSync(join(ws, '.claude'), { recursive: true })
    mkdirSync(join(home, 'cmds'))
    put(home, 'cmds/leak.md', 'private')
    symlinkSync(join(home, 'cmds'), join(ws, '.claude', 'commands'))
    put(home, 'skills/x/SKILL.md', 'private')
    mkdirSync(join(ws, '.claude', 'skills'))
    symlinkSync(join(home, 'skills', 'x'), join(ws, '.claude', 'skills', 'x'))
    expect(await ids()).toEqual([])
  })

  it('skips a skill that bundles a symlink-only folder or is missing SKILL.md', async () => {
    put(ws, '.claude/skills/none/readme.md', 'no skill file')
    expect(await ids()).toEqual([])
  })
})

describe('importSelected', () => {
  it('copies only the chosen finds and never touches the originals', async () => {
    const src = put(home, '.codex/AGENTS.md', 'Use tabs.')
    put(home, '.claude/commands/review.md', 'Review it')
    const outcome = await importSelected(['rules:user:~/.codex/AGENTS.md'], deps())
    expect(outcome).toEqual({ imported: ['rules:user:~/.codex/AGENTS.md'], failed: [] })
    expect(readFileSync(globalRulesFile(home), 'utf8')).toBe(
      `# Global instructions\n\n${rulesMarker('~/.codex/AGENTS.md')}\nUse tabs.\n`
    )
    expect(readFileSync(src, 'utf8')).toBe('Use tabs.')
    expect(existsSync(join(home, '.houston/commands/review.md'))).toBe(false)
    // Imported once: the next scan shows it as present, and a second import is refused.
    const again = await scanImportables(deps())
    expect(again.candidates.find((c) => c.kind === 'rules')?.status).toBe('present')
    const second = await importSelected(['rules:user:~/.codex/AGENTS.md'], deps())
    expect(second.failed).toEqual([{ id: 'rules:user:~/.codex/AGENTS.md', reason: 'Already imported' }])
  })

  it('appends project instructions to the existing AGENTS.md', async () => {
    put(ws, 'AGENTS.md', '# Project\n\nExisting.\n')
    put(ws, '.cursorrules', 'Be brief.')
    await importSelected(['rules:project:.cursorrules'], deps())
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toBe(
      `# Project\n\nExisting.\n\n${rulesMarker('.cursorrules')}\nBe brief.\n`
    )
  })

  it('imports the old global rules file through an import line and records the notice as answered', async () => {
    put(home, '.claude/CLAUDE.md', 'Legacy.')
    const onLegacyImported = vi.fn()
    const outcome = await importSelected(['rules:user:~/.claude/CLAUDE.md'], deps({ onLegacyImported }))
    expect(outcome.imported).toEqual(['rules:user:~/.claude/CLAUDE.md'])
    expect(readFileSync(globalRulesFile(home), 'utf8')).toContain(LEGACY_RULES_IMPORT)
    expect(onLegacyImported).toHaveBeenCalledOnce()
    // The offer leaves that file to its own notice.
    expect(await hasNewImportables(deps())).toBe(false)
  })

  it('adds user servers switched off, and project servers to .houston/settings.json', async () => {
    put(home, '.cursor/mcp.json', JSON.stringify({ mcpServers: { git: { command: 'uvx', args: ['g'], env: { T: 'v' } } } }))
    put(ws, '.mcp.json', JSON.stringify({ mcpServers: { db: { command: 'db-mcp' }, web: { url: 'https://h/mcp' } } }))
    put(ws, '.houston/settings.json', JSON.stringify({ permissions: { allow: ['x'] }, mcpServers: [{ id: 'keep', command: 'k' }] }))
    const outcome = await importSelected(
      ['mcp:user:~/.cursor/mcp.json:git', 'mcp:project:.mcp.json:db', 'mcp:project:.mcp.json:web'],
      deps()
    )
    expect(outcome.failed).toEqual([])
    expect(userServers).toEqual([
      { id: 'git', transport: 'stdio', command: 'uvx', args: ['g'], env: { T: 'v' }, enabled: false }
    ])
    expect(outcome.settings).toBeDefined()
    const project = JSON.parse(readFileSync(join(ws, '.houston/settings.json'), 'utf8'))
    expect(project).toEqual({
      permissions: { allow: ['x'] },
      mcpServers: [
        { id: 'keep', command: 'k' },
        { id: 'db', transport: 'stdio', command: 'db-mcp' },
        { id: 'web', transport: 'http', command: '', url: 'https://h/mcp' }
      ]
    })
  })

  it('refuses to write project servers into a .houston/settings.json that is not an object', async () => {
    put(ws, '.mcp.json', JSON.stringify({ mcpServers: { db: { command: 'db-mcp' } } }))
    put(ws, '.houston/settings.json', '[1,2]')
    const outcome = await importSelected(['mcp:project:.mcp.json:db'], deps())
    expect(outcome.imported).toEqual([])
    expect(outcome.failed[0].reason).toContain('not a JSON object')
    expect(readFileSync(join(ws, '.houston/settings.json'), 'utf8')).toBe('[1,2]')
  })

  it('copies a skill folder and a command, skipping links inside the skill', async () => {
    put(ws, '.claude/skills/deploy/SKILL.md', 'Steps')
    put(ws, '.claude/skills/deploy/ref/a.md', 'A')
    symlinkSync(put(home, 'outside.txt', 'private'), join(ws, '.claude/skills/deploy/link.txt'))
    put(ws, '.claude/commands/fix.md', 'Fix it')
    const outcome = await importSelected(['skill:project:.claude/skills/deploy', 'command:project:.claude/commands/fix.md'], deps())
    expect(outcome.failed).toEqual([])
    expect(readFileSync(join(ws, '.houston/skills/deploy/SKILL.md'), 'utf8')).toBe('Steps')
    expect(readFileSync(join(ws, '.houston/skills/deploy/ref/a.md'), 'utf8')).toBe('A')
    expect(existsSync(join(ws, '.houston/skills/deploy/link.txt'))).toBe(false)
    expect(readFileSync(join(ws, '.houston/commands/fix.md'), 'utf8')).toBe('Fix it')
  })

  it('refuses to copy into a project .houston folder that links outside the project', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'houston-impout-'))
    try {
      symlinkSync(elsewhere, join(ws, '.houston'))
      put(ws, '.claude/commands/fix.md', 'Fix it')
      const outcome = await importSelected(['command:project:.claude/commands/fix.md'], deps())
      expect(outcome.imported).toEqual([])
      expect(outcome.failed[0].reason).toContain('points outside the folder')
      expect(existsSync(join(elsewhere, 'commands', 'fix.md'))).toBe(false)
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('ignores ids it did not find and anything that is not a list of strings', async () => {
    expect(await importSelected(['mcp:user:/etc/passwd:x'], deps())).toEqual({
      imported: [],
      failed: [{ id: 'mcp:user:/etc/passwd:x', reason: 'No longer found' }]
    })
    expect(await importSelected('nope', deps())).toEqual({ imported: [], failed: [] })
    expect(await importSelected([42], deps())).toEqual({ imported: [], failed: [] })
  })
})

describe('withImportedRules', () => {
  it('starts a new file with the heading, or appends after existing text', () => {
    expect(withImportedRules(null, 'M', 'body', '# H')).toBe('# H\n\nM\nbody\n')
    expect(withImportedRules('', 'M', 'body')).toBe('M\nbody\n')
    expect(withImportedRules('old\n\n\n', 'M', ' body ')).toBe('old\n\nM\nbody\n')
  })
})
