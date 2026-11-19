import { describe, expect, it } from 'vitest'
import { mcpServersFromJson, parseMcpServersJson } from './mcpJson'

describe('mcpServersFromJson', () => {
  it('reads the common mcpServers map, stdio and remote', () => {
    const { servers, problems } = mcpServersFromJson({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'pkg', '.'], env: { TOKEN: 'x', N: 3 } },
        remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } },
        old: { type: 'sse', url: 'https://example.com/sse' }
      }
    })
    expect(problems).toEqual([])
    expect(servers).toEqual([
      { id: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'pkg', '.'], env: { TOKEN: 'x', N: '3' }, enabled: true },
      { id: 'remote', transport: 'http', command: '', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' }, enabled: true },
      { id: 'old', transport: 'sse', command: '', url: 'https://example.com/sse', enabled: true }
    ])
  })

  it('reads the servers key, a bare map, alternate url keys and the array form', () => {
    expect(mcpServersFromJson({ servers: { a: { command: 'x' } } }).servers.map((s) => s.id)).toEqual(['a'])
    expect(mcpServersFromJson({ b: { command: 'y' } }).servers.map((s) => s.id)).toEqual(['b'])
    expect(mcpServersFromJson({ mcpServers: { c: { serverUrl: 'https://h/x' } } }).servers[0].url).toBe('https://h/x')
    expect(mcpServersFromJson({ mcpServers: { d: { httpUrl: 'https://h/y' } } }).servers[0].url).toBe('https://h/y')
    expect(mcpServersFromJson({ mcpServers: [{ id: 'e', command: 'z' }] }).servers.map((s) => s.id)).toEqual(['e'])
  })

  it("reads Gemini CLI settings' url as SSE and httpUrl as streamable HTTP", () => {
    const servers = mcpServersFromJson(
      {
        mcpServers: {
          a: { url: 'https://h/sse' },
          b: { httpUrl: 'https://h/mcp' },
          c: { url: 'https://h/sse', httpUrl: 'https://h/mcp' },
          d: { url: 'https://h/mcp', type: 'http' }
        }
      },
      'gemini'
    ).servers
    expect(servers.map((s) => [s.id, s.transport, s.url])).toEqual([
      ['a', 'sse', 'https://h/sse'],
      ['b', 'http', 'https://h/mcp'],
      ['c', 'http', 'https://h/mcp'],
      ['d', 'http', 'https://h/mcp']
    ])
    // Pasted JSON keeps reading url as streamable HTTP.
    expect(mcpServersFromJson({ mcpServers: { a: { url: 'https://h/x' } } }).servers[0].transport).toBe('http')
  })

  it('sanitizes names and reports entries it cannot use', () => {
    const { servers, problems } = mcpServersFromJson({
      mcpServers: {
        'my server__x': { command: 'run' },
        empty: {},
        bad: { url: 'file:///etc/passwd' },
        list: ['nope']
      }
    })
    expect(servers.map((s) => s.id)).toEqual(['my-server_x'])
    expect(problems).toEqual([
      'empty: needs a "command" or a "url"',
      'bad: the url must start with http:// or https://',
      'list: not an object'
    ])
  })

  it('keeps number and boolean args as text, and reports any other non-string arg', () => {
    const { servers, problems } = mcpServersFromJson({
      mcpServers: {
        x: { command: 'node', args: ['server.js', '--port', 3000, '--verbose', true] },
        y: { command: 'node', args: ['server.js', { port: 1 }] }
      }
    })
    expect(servers).toEqual([
      { id: 'x', transport: 'stdio', command: 'node', args: ['server.js', '--port', '3000', '--verbose', 'true'], enabled: true }
    ])
    expect(problems).toEqual(['y: "args" must be a list of strings'])
  })

  it('keeps the first of two servers with the same sanitized name', () => {
    const r = mcpServersFromJson({ mcpServers: { 'a b': { command: 'one' }, 'a-b': { command: 'two' } } })
    expect(r.servers).toHaveLength(1)
    expect(r.servers[0].command).toBe('one')
    expect(r.problems[0]).toContain('used twice')
  })

  it('finds nothing in an unrelated settings object', () => {
    expect(mcpServersFromJson({ theme: 'dark', fontSize: 12 })).toEqual({ servers: [], problems: [] })
    expect(mcpServersFromJson(null)).toEqual({ servers: [], problems: [] })
  })
})

describe('parseMcpServersJson', () => {
  it('reports invalid JSON and an object with no servers', () => {
    expect(parseMcpServersJson('{nope')).toHaveProperty('error')
    expect(parseMcpServersJson('{"theme":"dark"}')).toEqual({ error: 'No servers found. Paste an object with an "mcpServers" map.' })
  })

  it('returns the servers from pasted text', () => {
    const r = parseMcpServersJson('{"mcpServers":{"git":{"command":"uvx","args":["mcp-server-git"]}}}')
    expect(r).toEqual({ servers: [{ id: 'git', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'], enabled: true }], problems: [] })
  })
})
