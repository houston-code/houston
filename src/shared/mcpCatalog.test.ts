import { describe, expect, it } from 'vitest'
import { MCP_CATALOG, PROJECT_PLACEHOLDER, addPastedServers, catalogServer, freeServerId, serverIdProblem, serverProblem } from './mcpCatalog'
import { sanitizeServerId } from './mcp'

describe('MCP_CATALOG', () => {
  it('has unique, namespacing-safe ids and a runnable target for every entry', () => {
    const ids = MCP_CATALOG.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const e of MCP_CATALOG) {
      expect(sanitizeServerId(e.id)).toBe(e.id)
      if (e.transport === 'http') expect(e.url).toMatch(/^https:\/\//)
      else expect(e.command).toMatch(/^(npx|uvx)$/)
    }
  })

  it('pins nothing to a local path and holds no secret values', () => {
    for (const e of MCP_CATALOG) {
      for (const a of e.args) expect(a === PROJECT_PLACEHOLDER || !a.startsWith('/')).toBe(true)
      for (const v of Object.values(e.headers ?? {})) expect(v).not.toMatch(/gh[pousr]_|Bearer \S{20,}/)
    }
  })
})

describe('catalogServer', () => {
  const fs = MCP_CATALOG.find((e) => e.id === 'filesystem')!
  const gh = MCP_CATALOG.find((e) => e.id === 'github')!

  it('fills the project folder in, and starts switched off', () => {
    expect(catalogServer(fs, '/w/my app')).toEqual({
      id: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/w/my app'],
      enabled: false
    })
  })

  it('leaves the placeholder with no project, which review then asks to replace', () => {
    const s = catalogServer(fs, null)
    expect(s.args).toEqual(['-y', '@modelcontextprotocol/server-filesystem', '{project}'])
    expect(serverProblem(s, [])).toBe('Replace {project} with a folder path.')
    expect(serverProblem({ ...s, args: ['-y', ' '] }, [])).toBe('Fill in every argument, or remove the empty ones.')
  })

  it('gives a remote entry its URL and empty header values to fill', () => {
    const s = catalogServer(gh, null)
    expect(s).toMatchObject({ transport: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: '' } })
    expect(serverProblem(s, [])).toBe('Fill in the Authorization header.')
    expect(serverProblem({ ...s, headers: { Authorization: 'Bearer x' } }, [])).toBeNull()
  })
})

describe('serverProblem', () => {
  const base = { id: 'x', transport: 'stdio' as const, command: 'npx', args: ['a'], enabled: false }
  it('names what is missing', () => {
    expect(serverProblem({ ...base, id: '' }, [])).toMatch(/Give it an id/)
    expect(serverProblem(base, ['x'])).toBe('There is already a server with the id x.')
    expect(serverProblem({ ...base, command: ' ' }, [])).toBe('Enter the command to run.')
    expect(serverProblem({ ...base, env: { TOKEN: '' } }, [])).toBe('Fill in the TOKEN variable.')
    expect(serverProblem({ ...base, transport: 'http', command: '', url: 'ftp://x' }, [])).toMatch(/URL/)
    expect(serverProblem(base, [])).toBeNull()
  })
})

describe('serverIdProblem', () => {
  it('flags only an empty or taken id', () => {
    expect(serverIdProblem('', [])).toMatch(/Give it an id/)
    expect(serverIdProblem('github', ['github'])).toBe('There is already a server with the id github.')
    expect(serverIdProblem('github', ['linear'])).toBeNull()
  })
})

describe('freeServerId', () => {
  it('suffixes a taken id', () => {
    expect(freeServerId('git', [])).toBe('git')
    expect(freeServerId('git', ['git', 'git-2'])).toBe('git-3')
    expect(freeServerId('', [])).toBe('server')
  })
})

describe('addPastedServers', () => {
  it('appends new servers switched off and skips taken ids', () => {
    const current = [{ id: 'git', command: 'old', enabled: true }]
    const r = addPastedServers(current, [
      { id: 'git', command: 'new', enabled: true },
      { id: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], enabled: true }
    ])
    expect(r.added).toEqual(['fetch'])
    expect(r.skipped).toEqual(['git'])
    expect(r.servers).toEqual([current[0], { id: 'fetch', command: 'uvx', args: ['mcp-server-fetch'], enabled: false }])
  })
})
