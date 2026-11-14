import { describe, expect, it } from 'vitest'
import {
  cleanRegistryText,
  isExactVersion,
  normalizeRegistryPage,
  normalizeRegistryServer,
  pinnedImage,
  registryDelivery,
  registryInstallOptions,
  registryServerId,
  safeHttpsUrl,
  type RegistryOption,
  type RegistryServer
} from './mcpRegistry'
import { applyDraftInputs, serverProblem } from './mcpCatalog'

/** A page shaped like `GET /v0.1/servers` answers (server.json 2025-09-29). */
const page = {
  servers: [
    {
      server: {
        name: 'io.github.acme/weather',
        title: 'Weather',
        description: 'Forecasts.\u001b[31m red\u202e evil\u0007',
        version: '1.2.3',
        repository: { url: 'https://github.com/acme/weather', source: 'github' },
        packages: [
          {
            registryType: 'npm',
            identifier: '@acme/weather-mcp',
            version: '1.2.3',
            runtimeHint: 'node --inspect',
            transport: { type: 'stdio' },
            runtimeArguments: [{ type: 'named', name: '--registry', value: 'https://evil.example' }],
            packageArguments: [
              { type: 'positional', value: 'serve' },
              { type: 'named', name: '--units', value: 'metric' },
              { type: 'positional', valueHint: 'city', isRequired: true },
              { type: 'positional', valueHint: 'optional_thing' }
            ],
            environmentVariables: [
              { name: 'WEATHER_KEY', description: 'API key', isRequired: true, isSecret: true },
              { name: 'WEATHER_REGION', description: 'Region', default: 'eu' },
              { name: 'BAD NAME', isRequired: true },
              { name: '$(touch x)' }
            ]
          }
        ],
        remotes: [
          {
            type: 'streamable-http',
            url: 'https://mcp.acme.example/mcp',
            headers: [{ name: 'Authorization', description: 'Bearer token', isRequired: true, isSecret: true, value: 'Bearer {api_key}' }]
          }
        ]
      },
      _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } }
    },
    { server: { name: '' } },
    'junk',
    {
      server: {
        name: 'com.example/repo-link',
        description: 'x'.repeat(2000),
        version: '0.1.0',
        repository: { url: 'javascript:alert(1)' },
        websiteUrl: 'http://plain.example'
      }
    }
  ],
  metadata: { nextCursor: 'io.github.acme/weather:1.2.3', count: 4 }
}

const options = (s: RegistryServer): Array<Extract<RegistryOption, { draft: unknown }>> =>
  registryInstallOptions(s).filter((o): o is Extract<RegistryOption, { draft: unknown }> => 'draft' in o)

describe('normalizeRegistryPage', () => {
  it('keeps valid entries as plain, cleaned display data and the next cursor', () => {
    const p = normalizeRegistryPage(page)
    expect(p.nextCursor).toBe('io.github.acme/weather:1.2.3')
    expect(p.servers.map((s) => s.name)).toEqual(['io.github.acme/weather', 'com.example/repo-link'])
    const [w, other] = p.servers
    expect(w.description).toBe('Forecasts. [31m red evil')
    expect([...w.description].some((ch) => ch.charCodeAt(0) < 0x20 || ch === '\u202e')).toBe(false)
    expect(w.repositoryUrl).toBe('https://github.com/acme/weather')
    expect(w.status).toBe('active')
    // Env names must be real variable names; anything else is dropped.
    expect(w.packages[0].env.map((e) => e.name)).toEqual(['WEATHER_KEY', 'WEATHER_REGION'])
    expect(w.remotes[0].headers[0]).toMatchObject({ name: 'Authorization', required: true, secret: true, format: 'Bearer {api_key}' })
    expect(other.description.length).toBeLessThanOrEqual(400)
    expect(other.repositoryUrl).toBeUndefined()
    expect(other.websiteUrl).toBeUndefined()
  })

  it('rejects an answer that is not a page', () => {
    expect(() => normalizeRegistryPage({ nope: 1 })).toThrow()
    expect(() => normalizeRegistryPage(null)).toThrow()
    expect(() => normalizeRegistryServer({ server: { description: 'no name' } })).toThrow()
  })

  it('caps how many servers it keeps', () => {
    const many = { servers: Array.from({ length: 500 }, (_, i) => ({ server: { name: `a/s${i}`, version: '1.0.0' } })) }
    expect(normalizeRegistryPage(many).servers).toHaveLength(100)
  })
})

describe('text and URL helpers', () => {
  it('cleans and caps text', () => {
    expect(cleanRegistryText('a\n\tb\u200bc', 50)).toBe('a b c')
    expect(cleanRegistryText(42, 10)).toBe('')
    expect(cleanRegistryText('abcdefghij', 5)).toBe('abcd…')
  })

  it('accepts https URLs only', () => {
    expect(safeHttpsUrl('https://github.com/a/b')).toBe('https://github.com/a/b')
    expect(safeHttpsUrl('http://github.com/a/b')).toBeUndefined()
    expect(safeHttpsUrl('file:///etc/passwd')).toBeUndefined()
    expect(safeHttpsUrl('https://a b')).toBeUndefined()
  })

  it('tells exact versions from tags and ranges', () => {
    for (const v of ['1.2.3', '0.1.0-beta.1', 'v2.0.0', '2024.1.5']) expect(isExactVersion(v)).toBe(true)
    for (const v of [undefined, '', 'latest', '^1.2.3', '~1.0', '1.x || 2', '*', '>=1.0.0', 'next']) expect(isExactVersion(v)).toBe(false)
  })

  it('pins images by tag, version or digest, never latest', () => {
    expect(pinnedImage('ghcr.io/acme/srv:1.0.1', undefined)).toBe('ghcr.io/acme/srv:1.0.1')
    expect(pinnedImage('acme/srv', '2.0.0')).toBe('acme/srv:2.0.0')
    expect(pinnedImage('localhost:5000/acme/srv', '2.0.0')).toBe('localhost:5000/acme/srv:2.0.0')
    expect(pinnedImage(`acme/srv@sha256:${'a'.repeat(64)}`, undefined)).toBe(`acme/srv@sha256:${'a'.repeat(64)}`)
    expect(pinnedImage('acme/srv:latest', '2.0.0')).toBeNull()
    expect(pinnedImage('acme/srv', undefined)).toBeNull()
    expect(pinnedImage('--privileged', '1.0.0')).toBeNull()
  })

  it('suggests an id from the last part of the name', () => {
    expect(registryServerId('io.github.acme/weather')).toBe('weather')
    expect(registryServerId('com.x/My Server!')).toBe('My-Server')
  })
})

describe('registryInstallOptions', () => {
  const weather = normalizeRegistryPage(page).servers[0]

  it('converts an npm package to a pinned npx server, switched off, without the publisher runtime options', () => {
    const [npm] = options(weather)
    expect(npm.kind).toBe('stdio')
    expect(npm.draft.server).toEqual({
      id: 'weather',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@acme/weather-mcp@1.2.3', 'serve', '--units', 'metric', '{city}'],
      env: { WEATHER_KEY: '', WEATHER_REGION: '' },
      enabled: false
    })
    expect(npm.draft.note).toMatch(/Left out the publisher's npx options \(--registry https:\/\/evil\.example\)/)
    expect(npm.draft.needs).toBe('Node.js (npx)')
  })

  it('makes the review form ask for required placeholders and values', () => {
    const [npm] = options(weather)
    const inputs = npm.draft.inputs ?? []
    const empty = applyDraftInputs(npm.draft.server, inputs, {})
    expect(empty.env).toEqual({ WEATHER_KEY: '' })
    expect(serverProblem(empty, [])).toBe('Replace {city} in the arguments.')
    const filled = applyDraftInputs({ ...npm.draft.server, args: ['-y', '@acme/weather-mcp@1.2.3', 'Paris'] }, inputs, {})
    expect(serverProblem(filled, [])).toBe('Fill in the WEATHER_KEY variable.')
    const done = applyDraftInputs(filled, inputs, { 'env:WEATHER_KEY': ' k ', 'env:WEATHER_REGION': '' })
    expect(done.env).toEqual({ WEATHER_KEY: 'k' })
    expect(serverProblem(done, [])).toBeNull()
  })

  it('converts a remote to an http server with an empty header to fill in', () => {
    const remote = options(weather).find((o) => o.kind === 'remote')!
    expect(remote.draft.server).toEqual({
      id: 'weather',
      transport: 'http',
      command: '',
      args: [],
      url: 'https://mcp.acme.example/mcp',
      headers: { Authorization: '' },
      enabled: false
    })
    const s = applyDraftInputs(remote.draft.server, remote.draft.inputs ?? [], {})
    expect(serverProblem(s, [])).toBe('Fill in the Authorization header.')
    expect(serverProblem(applyDraftInputs(s, remote.draft.inputs ?? [], { 'header:Authorization': 'Bearer t' }), [])).toBeNull()
  })

  const server = (over: Partial<RegistryServer>): RegistryServer => ({
    name: 'io.github.acme/x',
    description: '',
    version: '1.0.0',
    packages: [],
    remotes: [],
    ...over
  })
  const pkg = (p: Partial<RegistryServer['packages'][number]>): RegistryServer['packages'][number] => ({
    registryType: 'npm',
    identifier: 'x-mcp',
    version: '1.0.0',
    transport: 'stdio',
    env: [],
    packageArguments: [],
    runtimeArguments: [],
    ...p
  })

  it('pins PyPI packages for uvx and images for docker, passing variables with -e', () => {
    const py = options(server({ packages: [pkg({ registryType: 'pypi', identifier: 'x_mcp', version: '0.6.1' })] }))[0]
    expect(py.draft.server).toMatchObject({ command: 'uvx', args: ['x_mcp@0.6.1'] })
    const env = [{ kind: 'env' as const, name: 'TOKEN', description: '', required: true, secret: true }]
    const oci = options(server({ packages: [pkg({ registryType: 'oci', identifier: 'ghcr.io/a/b:1.0.1', version: undefined, env })] }))[0]
    expect(oci.draft.server).toMatchObject({ command: 'docker', args: ['run', '-i', '--rm', '-e', 'TOKEN', 'ghcr.io/a/b:1.0.1'] })
  })

  it('refuses what it cannot pin or run', () => {
    const why = (p: Partial<RegistryServer['packages'][number]>): string | undefined => {
      const [o] = registryInstallOptions(server({ packages: [pkg(p)] }))
      return 'unsupported' in o ? o.unsupported : undefined
    }
    expect(why({ version: 'latest' })).toMatch(/exact version/)
    expect(why({ version: '^1.0.0' })).toMatch(/exact version/)
    expect(why({ identifier: '-e evil' })).toMatch(/not a valid npm name/)
    expect(why({ identifier: 'x; rm -rf /' })).toMatch(/not a valid npm name/)
    expect(why({ registryType: 'pypi', identifier: '--index-url=http://x' })).toMatch(/not a valid PyPI name/)
    expect(why({ registryType: 'oci', identifier: 'a/b:latest', version: undefined })).toMatch(/tag or digest/)
    expect(why({ registryType: 'nuget' })).toMatch(/can't install nuget/)
    expect(why({ transport: 'streamable-http' })).toMatch(/local web server/)
    const [r] = registryInstallOptions(server({ remotes: [{ type: 'streamable-http', url: 'http://plain.example/mcp', headers: [] }] }))
    expect('unsupported' in r && r.unsupported).toMatch(/https/)
    const [sse] = options(server({ remotes: [{ type: 'sse', url: 'https://a.example/sse', headers: [] }] }))
    expect(sse.draft.server.transport).toBe('sse')
  })

  it('keeps a URL template for the user to fill in', () => {
    const [o] = options(server({ remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example/mcp', headers: [] }] }))
    expect(serverProblem(o.draft.server, [])).toBe('Replace {tenant} in the URL.')
  })

  it('describes how an entry is delivered', () => {
    expect(registryDelivery(weather)).toBe('npm @acme/weather-mcp 1.2.3 (stdio) · remote streamable-http')
    expect(registryDelivery(server({}))).toBe('no install details')
  })
})
