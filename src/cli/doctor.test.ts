import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DoctorFacts } from '@shared/doctor'
import { schemaProblems, validateJson, type JsonSchema } from '@shared/jsonSchema'
import { runDoctorCommand, type DoctorCliDeps } from './doctor'
import { renderDoctor } from '../main/tui-doctor'
import { plainText } from '../main/tui-a11y'

const schema = JSON.parse(
  readFileSync(join(__dirname, '../../docs/schemas/doctor.schema.json'), 'utf8')
) as JsonSchema

function facts(over: Partial<DoctorFacts> = {}): DoctorFacts {
  return {
    version: '0.12.0',
    nodeVersion: 'v22.11.0',
    platform: 'darwin arm64',
    cwd: '/work/proj',
    settingsPath: '/data/settings.json',
    sandbox: { backend: 'seatbelt', enforced: true },
    providers: [{ id: 'anthropic', requiresKey: true, hasKey: true }],
    active: { providerId: 'anthropic', model: 'claude' },
    mcp: [],
    binaries: [{ name: 'rg', path: null, purpose: 'faster search_files' }],
    update: null,
    install: { method: 'npm', upgrade: 'npm i -g @houston-code/cli@latest' },
    terminal: { tty: true, color: false, columns: 100, term: 'xterm' },
    ...over
  }
}

function harness(f: DoctorFacts | (() => Promise<DoctorFacts>), render = (s: string) => s) {
  const out: string[] = []
  const err: string[] = []
  const progress: string[] = []
  const deps: DoctorCliDeps = {
    facts: typeof f === 'function' ? f : async () => f,
    render: (r) => render(renderDoctor(r, (s) => s)),
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    progress: (m) => void progress.push(m)
  }
  return { deps, out, err, progress, run: (...args: string[]) => runDoctorCommand(args, deps) }
}

describe('houston doctor', () => {
  it('prints the painted /doctor report and exits 0 when only warnings come up', async () => {
    const h = harness(facts())
    expect(await h.run()).toBe(0)
    const text = h.out.join('')
    expect(text).toContain('Houston')
    expect(text).toContain('install')
    expect(text).toMatch(/rg\s+not found on PATH/)
    expect(text).toContain('worth knowing')
    expect(h.progress).toEqual(['Checking your setup...'])
  })

  it('exits 1 when a check fails', async () => {
    const h = harness(facts({ active: null }))
    expect(await h.run()).toBe(1)
    expect(h.out.join('')).toContain('1 problem found')
    const failingMcp = harness(facts({ mcp: [{ id: 'gh', state: 'error', detail: 'spawn ENOENT' }] }))
    expect(await failingMcp.run('--json')).toBe(1)
  })

  it('never prints a key: a provider row says only whether one is set', async () => {
    const h = harness(facts({ providers: [{ id: 'openai', requiresKey: true, hasKey: true, shadowedByEnv: 'OPENAI_API_KEY' }] }))
    await h.run('--json')
    const json = h.out.join('')
    expect(json).toContain('OPENAI_API_KEY in your environment takes precedence')
    expect(json).not.toMatch(/sk-/)
  })

  it('prints --json in the documented shape, with nothing else on stdout', async () => {
    expect(schemaProblems(schema)).toEqual([])
    const h = harness(facts({ mcp: [{ id: 'remote', state: 'needs-auth' }] }))
    expect(await h.run('--json')).toBe(0)
    expect(h.out).toHaveLength(1)
    expect(h.progress).toEqual([]) // no progress chatter around machine output
    const doc = JSON.parse(h.out[0])
    expect(validateJson(schema, doc)).toEqual([])
    expect(doc).toMatchObject({ schemaVersion: 1, version: '0.12.0', ok: true })
    expect(doc.counts.warn).toBeGreaterThan(0)
    const mcp = doc.groups.find((g: { title: string }) => g.title === 'MCP')
    expect(mcp.checks).toEqual([{ label: 'remote', status: 'warn', detail: 'needs sign-in', fix: 'houston mcp login remote' }])
    // A fix shows only on a row that needs one.
    const houston = doc.groups.find((g: { title: string }) => g.title === 'Houston')
    expect(houston.checks.every((c: { fix?: string }) => c.fix === undefined)).toBe(true)
    // Empty sections are left out rather than printed as [] (no MCP servers here).
    const none = harness(facts())
    await none.run('--json')
    expect(JSON.parse(none.out[0]).groups.map((g: { title: string }) => g.title)).not.toContain('MCP')
  })

  it('the schema rejects a malformed report', () => {
    expect(validateJson(schema, { schemaVersion: 1, version: 'x', ok: true, counts: { ok: 0, warn: 0, fail: 0 }, groups: [{ title: 't', checks: [{ label: 'l', status: 'bad', detail: '' }] }] }).length).toBeGreaterThan(0)
    expect(validateJson(schema, { schemaVersion: 2 }).length).toBeGreaterThan(0)
  })

  it('reads plain in screen-reader mode: status marks become words, no escapes', async () => {
    const h = harness(facts({ active: null }), plainText)
    await h.run()
    const text = h.out.join('')
    expect(text).toContain('failed: active model')
    expect(text).toContain('done: version')
    expect(text).not.toMatch(/[✓✗→]/)
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\u001b/)
  })

  it('rejects stray arguments with exit 2 and says why', async () => {
    const h = harness(facts())
    expect(await h.run('--jsn')).toBe(2)
    expect(h.err.join('')).toContain('doctor takes no option --jsn')
    expect(await h.run('now')).toBe(2)
    expect(h.err.join('')).toContain('doctor takes no argument "now"')
  })

  it('reports a probe that throws as exit 1, not a crash', async () => {
    const h = harness(async () => {
      throw new Error('settings unreadable')
    })
    expect(await h.run()).toBe(1)
    expect(h.err.join('')).toContain("couldn't run the checks: settings unreadable")
  })
})
