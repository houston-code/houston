import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'

// A session directory (`--add-dir`, `/add-dir`) through the real loop: it widens the
// run's roots exactly as Settings' additional directories do, for that run only.

const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [], mcpServers: [], additionalRoots: [] } as Record<
    string,
    unknown
  >
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'p', kind: 'anthropic', label: 'P', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
vi.mock('./managedPolicy', () => ({ loadManagedPolicy: async () => ({ permissionRules: [] }) }))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => [], releaseMcpRun: () => {} }))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))
vi.mock('./plugins', () => ({
  loadPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  loadPluginsIfEnabled: async () => ({ has: () => false, size: 0, emit: async () => {} })
}))

const { startRun } = await import('./loop')

let root: string
let ws: string
let other: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'houston-adddir-loop-')))
  ws = join(root, 'ws')
  other = join(root, 'other')
  mkdirSync(ws)
  mkdirSync(other)
  writeFileSync(join(other, 'notes.txt'), 'from the other folder\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

async function readOther(addDirs?: string[]): Promise<string> {
  const turns: ProviderStreamEvent[][] = [
    [
      { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: join(other, 'notes.txt') } } },
      { type: 'done', stopReason: 'tool_use' }
    ]
  ]
  let i = 0
  h.provider = {
    async *streamChat(_req: ChatRequest) {
      for (const ev of turns[i++] ?? [{ type: 'text', delta: 'done' }, { type: 'done', stopReason: 'end_turn' }]) yield ev
    }
  }
  const events: AgentEvent[] = []
  await startRun(
    {
      runId: `run-${Math.round(Math.random() * 1e9)}`,
      workspace: ws,
      providerId: 'p',
      model: 'claude-sonnet-5',
      approvalPolicy: 'full-auto',
      messages: [{ role: 'user', content: 'go' }],
      unattended: true,
      ...(addDirs ? { addDirs } : {})
    },
    (e) => events.push(e)
  )
  const result = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')
  return result?.output ?? ''
}

describe('session directories', () => {
  it('lets the run read a file in an added directory', async () => {
    expect(await readOther([other])).toContain('from the other folder')
  })

  it('keeps the same file out of reach without it', async () => {
    expect(await readOther()).not.toContain('from the other folder')
  })

  it('skips an added directory that no longer exists, like a stale setting', async () => {
    expect(await readOther([join(root, 'gone'), other])).toContain('from the other folder')
  })
})
