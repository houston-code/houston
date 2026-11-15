import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { findServer, parseMcpAddArgs, renderMcpCliList, runMcpCliCommand, type McpCliDeps } from './mcp'

const stdio: McpServerConfig = { id: 'fs', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'], enabled: true }
const remote: McpServerConfig = { id: 'gh', name: 'GitHub', transport: 'http', command: '', url: 'https://api.example.com/mcp', enabled: true }
const off: McpServerConfig = { id: 'old', transport: 'stdio', command: 'old-server', enabled: false }

function harness(initial: McpServerConfig[] = [], over: Partial<McpCliDeps> = {}) {
  let servers = [...initial]
  const out: string[] = []
  const err: string[] = []
  const connect = vi.fn(async (_s: McpServerConfig[]): Promise<McpServerStatus[]> => [])
  const login = vi.fn(async (_s: McpServerConfig, onStatus: (m: string) => void) => {
    onStatus('Open this URL in your browser to sign in:\nhttps://auth.example.com/authorize?x=1')
  })
  const logout = vi.fn()
  const deps: McpCliDeps = {
    servers: () => servers,
    save: (s) => {
      servers = s
    },
    connect,
    login,
    logout,
    paint: (s) => s,
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    ...over
  }
  return {
    deps,
    out,
    err,
    connect,
    login,
    logout,
    servers: () => servers,
    run: (...args: string[]) => runMcpCliCommand(args, deps)
  }
}

describe('parseMcpAddArgs', () => {
  it('reads a stdio server as <name> -- <command> [args...], keeping each argument whole', () => {
    expect(parseMcpAddArgs(['fs', '--', 'npx', '-y', 'server-fs', '/a folder'])).toEqual({
      kind: 'stdio',
      name: 'fs',
      command: 'npx',
      args: ['-y', 'server-fs', '/a folder']
    })
  })

  it('reads a remote server from --url, with an optional name and --sse', () => {
    expect(parseMcpAddArgs(['--url', 'https://h/mcp'])).toEqual({ kind: 'remote', url: 'https://h/mcp', name: '', sse: false })
    expect(parseMcpAddArgs(['--url=https://h/mcp', 'mine', '--sse'])).toEqual({ kind: 'remote', url: 'https://h/mcp', name: 'mine', sse: true })
  })

  it('explains each malformed form', () => {
    const e = (args: string[]): string => (parseMcpAddArgs(args) as { error: string }).error
    expect(e([])).toMatch(/name the server/)
    expect(e(['fs', 'npx'])).toMatch(/command after --/)
    expect(e(['fs', '--'])).toMatch(/command to spawn is required/)
    expect(e(['--url'])).toMatch(/--url needs a URL/)
    expect(e(['--url', 'https://h', '--', 'npx'])).toMatch(/takes no command/)
    expect(e(['--sse', 'x', '--', 'npx'])).toMatch(/--sse goes with --url/)
    expect(e(['--env', 'A=b', 'x', '--', 'npx'])).toMatch(/unknown option for mcp add: --env/)
  })
})

describe('houston mcp add', () => {
  it('adds a stdio server switched on, validated like /mcp add', async () => {
    const h = harness()
    expect(await h.run('add', 'fs', '--', 'npx', '-y', 'server-fs')).toBe(0)
    expect(h.servers()).toEqual([{ id: 'fs', name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'server-fs'], enabled: true }])
    expect(h.out.join('')).toContain('Added MCP server "fs": npx -y server-fs')
  })

  it('refuses a bad or taken name with exit 2 and saves nothing', async () => {
    const h = harness([stdio])
    expect(await h.run('add', 'fs', '--', 'npx')).toBe(2)
    expect(h.err.join('')).toContain('an MCP server named "fs" already exists')
    expect(await h.run('add', 'my server', '--', 'npx')).toBe(2)
    expect(h.servers()).toEqual([stdio])
  })

  it('adds a remote server named after its host, and points at houston mcp login', async () => {
    const h = harness()
    expect(await h.run('add', '--url', 'https://mcp.example.com/v1')).toBe(0)
    expect(h.servers()[0]).toMatchObject({ id: 'mcp-example-com', transport: 'http', url: 'https://mcp.example.com/v1', enabled: true })
    expect(h.out.join('')).toContain('houston mcp login mcp-example-com')
    expect(await h.run('add', '--url', 'https://sse.example.com/', 'legacy', '--sse')).toBe(0)
    expect(h.servers()[1]).toMatchObject({ id: 'legacy', transport: 'sse' })
  })

  it('refuses a non-http URL and credentials in the URL, naming the shell command', async () => {
    const h = harness()
    expect(await h.run('add', '--url', 'file:///etc/passwd')).toBe(2)
    expect(h.err.join('')).toContain('must start with http:// or https://')
    expect(await h.run('add', '--url', 'https://me:secret@h/mcp')).toBe(2)
    const msg = h.err.join('')
    expect(msg).toContain('leave credentials out of the URL')
    expect(msg).toContain('houston mcp login <name>')
    expect(h.servers()).toEqual([])
  })

  it('strips terminal escapes from echoed arguments', async () => {
    const h = harness()
    await h.run('add', 'x\u001b]52;c;aGk=\u0007', 'npx')
    // eslint-disable-next-line no-control-regex
    expect(h.err.join('').replace(/\n/g, ' ')).not.toMatch(/[\u0000-\u001f\u007f]/)
  })
})

describe('houston mcp list', () => {
  it('connects each enabled server and shows how it went, exit 1 when one fails', async () => {
    const h = harness([stdio, remote, off])
    h.connect.mockResolvedValueOnce([
      { id: 'fs', state: 'connected', tools: 3 },
      { id: 'gh', state: 'error', error: 'HTTP 500\u001b[2J' }
    ])
    expect(await h.run('list')).toBe(1)
    expect(h.connect.mock.calls[0][0].map((s) => s.id)).toEqual(['fs', 'gh'])
    const text = h.out.join('')
    expect(text).toContain('fs   [stdio]  npx -y server-fs')
    expect(text).toContain('connected, 3 tools')
    expect(text).toContain('failed: HTTP 500[2J')
    expect(text).toContain('old  [stdio]  old-server')
    expect(text).toContain('disabled')
    expect(text).not.toContain('\u001b')
  })

  it('is the default verb, exits 0 when nothing fails, and suggests a sign-in by shell command', async () => {
    const h = harness([remote])
    h.connect.mockResolvedValueOnce([{ id: 'gh', state: 'needs-auth' }])
    expect(await h.run()).toBe(0)
    expect(h.out.join('')).toContain('needs sign-in: houston mcp login gh')
  })

  it('says how to add one when there are none, without connecting anything', async () => {
    const h = harness()
    expect(await h.run('list')).toBe(0)
    expect(h.connect).not.toHaveBeenCalled()
    expect(h.out.join('')).toContain('houston mcp add <name> -- <command>')
  })

  it('never shows header or env values', () => {
    const secret: McpServerConfig = { ...stdio, env: { TOKEN: 'sekrit' }, headers: { Authorization: 'Bearer sekrit' } } as McpServerConfig
    expect(renderMcpCliList([secret], [], (s) => s)).not.toContain('sekrit')
  })
})

describe('houston mcp remove / login / logout', () => {
  it('finds a server by id, display name or /mcp number', () => {
    expect(findServer([stdio, remote], 'gh')).toBe(remote)
    expect(findServer([stdio, remote], 'GitHub')).toBe(remote)
    expect(findServer([stdio, remote], '1')).toBe(stdio)
    expect(findServer([stdio, remote], '3')).toBeUndefined()
    expect(findServer([stdio, remote], '0')).toBeUndefined()
  })

  it('removes a server, and says which exist when the name is wrong', async () => {
    const h = harness([stdio, remote])
    expect(await h.run('remove', 'fs')).toBe(0)
    expect(h.servers()).toEqual([remote])
    expect(await h.run('remove', 'nope')).toBe(1)
    expect(h.err.join('')).toContain('no MCP server "nope" (servers: gh)')
    expect(await h.run('remove')).toBe(2)
  })

  it('signs in through the OAuth flow, printing its URL for when no browser opens', async () => {
    const h = harness([remote])
    expect(await h.run('login', 'gh')).toBe(0)
    expect(h.login).toHaveBeenCalledWith(remote, expect.any(Function))
    const text = h.out.join('')
    expect(text).toContain('Open this URL in your browser to sign in:\nhttps://auth.example.com/authorize?x=1')
    expect(text).toContain('Signed in to "gh".')
  })

  it('reports a failed sign-in as exit 1', async () => {
    const h = harness([remote], {
      login: async () => {
        throw new Error('Timed out waiting for the browser sign-in (5 min).')
      }
    })
    expect(await h.run('login', 'gh')).toBe(1)
    expect(h.err.join('')).toContain('sign-in failed: Timed out')
  })

  it('refuses sign-in for a stdio server, and when the host cannot store tokens', async () => {
    const h = harness([stdio])
    expect(await h.run('login', 'fs')).toBe(1)
    expect(h.err.join('')).toContain('local stdio server')
    const noStore = harness([remote], { login: undefined, logout: undefined })
    expect(await noStore.run('login', 'gh')).toBe(1)
    expect(noStore.err.join('')).toContain('unavailable')
  })

  it('signs out only a server with a stored sign-in', async () => {
    const h = harness([remote, { ...remote, id: 'signed', hasOAuth: true }])
    expect(await h.run('logout', 'gh')).toBe(0)
    expect(h.out.join('')).toContain('no stored sign-in')
    expect(h.logout).not.toHaveBeenCalled()
    expect(await h.run('logout', 'signed')).toBe(0)
    expect(h.logout).toHaveBeenCalledWith('signed')
  })

  it('rejects an unknown verb with exit 2', async () => {
    const h = harness()
    expect(await h.run('frob')).toBe(2)
    expect(h.err.join('')).toContain('unknown command: mcp frob')
  })
})
