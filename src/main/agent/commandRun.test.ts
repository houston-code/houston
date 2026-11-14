import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from '@shared/commands'
import type { AppSettings } from '@shared/types'
import { parseAllowedTools, prepareCommandRun, workspaceTrusted } from './commandRun'
import { loadProjectConfig } from './projectConfig'

const settings = (over: Partial<AppSettings> = {}): AppSettings =>
  ({
    schemaVersion: 1,
    providers: [
      { id: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude' }, { id: 'haiku' }], defaultModel: 'claude' },
      { id: 'openai', requiresKey: true, hasKey: false, models: [{ id: 'gpt' }] }
    ],
    selected: null,
    approvalPolicy: 'ask',
    recentWorkspaces: [],
    ...over
  }) as unknown as AppSettings

const cmd = (over: Partial<Command> = {}): Command => ({
  name: 'deploy',
  description: 'Ship it',
  template: 'Deploy $1',
  source: 'project',
  ...over
})

describe('parseAllowedTools', () => {
  it('turns tool names and tool(pattern) entries into allow rules', () => {
    expect(parseAllowedTools('read_file, run_shell(npm test*)')).toEqual({
      rules: [
        { action: 'allow', tool: 'read_file', match: '*' },
        { action: 'allow', tool: 'run_shell', match: 'npm test*' }
      ]
    })
  })

  it('refuses a malformed list and a tool-name pattern a rule cannot match', () => {
    expect(parseAllowedTools('read_file,,glob')).toHaveProperty('error')
    expect(parseAllowedTools('run_shell(npm')).toHaveProperty('error')
    expect(parseAllowedTools('mcp__github__*')).toEqual({ error: expect.stringContaining('is a pattern') })
  })
})

describe('prepareCommandRun', () => {
  const trusted = { settings: settings(), trusted: true }
  const untrusted = { settings: settings(), trusted: false }

  it('is null for a command with no template', async () => {
    expect(await prepareCommandRun({ name: 'new', description: 'x' }, '', '/new', trusted)).toBeNull()
  })

  it('runs a plain command as its expanded prompt, with nothing else applied', async () => {
    const r = await prepareCommandRun(cmd(), 'staging', '/deploy staging', trusted)
    expect(r).toEqual({
      ok: true,
      run: {
        turn: {
          text: 'Deploy staging',
          invokedAs: { kind: 'command', label: '/deploy', detail: 'Ship it', typed: '/deploy staging' }
        },
        notes: []
      }
    })
  })

  it('picks the model and effort for this turn, and says so', async () => {
    const r = await prepareCommandRun(cmd({ model: 'haiku', effort: 'high' }), '', '/deploy', untrusted)
    expect(r?.ok && r.run).toMatchObject({
      model: { providerId: 'anthropic', model: 'haiku' },
      effort: 'high',
      notes: ['/deploy runs on anthropic/haiku for this turn', '/deploy thinks at high effort for this turn']
    })
  })

  it("keeps the chat's model when the named one isn't set up or has no key", async () => {
    const unknown = await prepareCommandRun(cmd({ model: 'mystery' }), '', '/deploy', trusted)
    expect(unknown?.ok && unknown.run.model).toBeUndefined()
    expect(unknown?.ok && unknown.run.notes[0]).toContain("isn't set up")
    const keyless = await prepareCommandRun(cmd({ model: 'openai/gpt' }), '', '/deploy', trusted)
    expect(keyless?.ok && keyless.run.model).toBeUndefined()
    expect(keyless?.ok && keyless.run.notes[0]).toContain('no API key')
  })

  it('hands the expanded prompt to the named subagent', async () => {
    const r = await prepareCommandRun(cmd({ agent: 'deployer' }), 'prod', '/deploy prod', untrusted)
    expect(r?.ok && r.run.turn.text).toContain('Use the `deployer` subagent')
    expect(r?.ok && r.run.turn.text).toContain('Deploy prod')
    expect(r?.ok && r.run.notes).toEqual(['/deploy hands its prompt to the deployer subagent'])
  })

  it("pre-approves a trusted project command's tools for the turn", async () => {
    const r = await prepareCommandRun(cmd({ allowedTools: 'read_file, run_shell(npm test*)' }), '', '/deploy', trusted)
    expect(r?.ok && r.run.turnAllowRules).toEqual([
      { action: 'allow', tool: 'read_file', match: '*' },
      { action: 'allow', tool: 'run_shell', match: 'npm test*' }
    ])
    expect(r?.ok && r.run.notes).toEqual(['pre-approved for this turn: read_file, run_shell(npm test*)'])
  })

  it("ignores an untrusted project command's allowed-tools, and says so", async () => {
    const r = await prepareCommandRun(cmd({ allowedTools: 'run_shell' }), '', '/deploy', untrusted)
    expect(r?.ok && r.run.turnAllowRules).toBeUndefined()
    expect(r?.ok && r.run.notes[0]).toMatch(/ignoring allowed-tools in \/deploy: this folder isn't trusted/)
  })

  it("honors a user-level command's allowed-tools in any folder", async () => {
    const r = await prepareCommandRun(cmd({ source: 'user', allowedTools: 'glob' }), '', '/deploy', untrusted)
    expect(r?.ok && r.run.turnAllowRules).toEqual([{ action: 'allow', tool: 'glob', match: '*' }])
  })

  it('ignores a malformed allowed-tools with the reason', async () => {
    const r = await prepareCommandRun(cmd({ source: 'user', allowedTools: 'run_shell(npm' }), '', '/deploy', trusted)
    expect(r?.ok && r.run.turnAllowRules).toBeUndefined()
    expect(r?.ok && r.run.notes[0]).toContain('missing its closing parenthesis')
  })
})

describe('workspaceTrusted', () => {
  let ws: string
  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-cr-')))
  })
  afterEach(() => rmSync(ws, { recursive: true, force: true }))

  it('is false for a folder with nothing to trust, and for one never decided', async () => {
    expect(await workspaceTrusted(ws, [])).toBe(false)
    mkdirSync(join(ws, '.houston/commands'), { recursive: true })
    writeFileSync(join(ws, '.houston/commands/x.md'), '---\nallowed-tools: glob\n---\nGo')
    expect(await workspaceTrusted(ws, [])).toBe(false)
  })

  it('is true only while the trust matches what is on disk now', async () => {
    mkdirSync(join(ws, '.houston/commands'), { recursive: true })
    writeFileSync(join(ws, '.houston/commands/x.md'), '---\nallowed-tools: glob\n---\nGo')
    const { elevatedHash } = await loadProjectConfig(ws)
    const records = [{ path: ws, decision: 'trusted' as const, hash: elevatedHash, decidedAt: 1 }]
    expect(await workspaceTrusted(ws, records)).toBe(true)
    // A pull widens the command: the old consent no longer covers it.
    writeFileSync(join(ws, '.houston/commands/x.md'), '---\nallowed-tools: glob, run_shell\n---\nGo')
    expect(await workspaceTrusted(ws, records)).toBe(false)
  })
})
