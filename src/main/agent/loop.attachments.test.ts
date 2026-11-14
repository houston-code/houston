import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'

// read_file attachments through the real loop: a PDF or image reaches the next request
// only when the route's provider and model can take it in, and otherwise the tool says
// it could not be viewed rather than claiming it is "attached below".

const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  kind: 'anthropic' as string,
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [], mcpServers: [], additionalRoots: [] } as Record<
    string,
    unknown
  >
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'p', kind: h.kind, label: 'P', models: [], requiresKey: false, hasKey: true, builtIn: true }),
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

// A 1x1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-attach-'))
  writeFileSync(join(ws, 'spec.pdf'), Buffer.from('%PDF-1.4 minimal'))
  writeFileSync(join(ws, 'logo.png'), PNG)
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

async function readThrough(kind: string, model: string, path: string): Promise<{ output: string; next: ChatRequest }> {
  h.kind = kind
  const requests: ChatRequest[] = []
  const turns: ProviderStreamEvent[][] = [
    [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path } } }, { type: 'done', stopReason: 'tool_use' }]
  ]
  let i = 0
  h.provider = {
    async *streamChat(req: ChatRequest) {
      requests.push(structuredClone(req))
      for (const ev of turns[i++] ?? [{ type: 'text', delta: 'done' }, { type: 'done', stopReason: 'end_turn' }]) yield ev
    }
  }
  const events: AgentEvent[] = []
  await startRun(
    {
      runId: `run-${Math.round(Math.random() * 1e9)}`,
      workspace: ws,
      providerId: 'p',
      model,
      approvalPolicy: 'full-auto',
      messages: [{ role: 'user', content: 'go' }],
      unattended: true
    },
    (e) => events.push(e)
  )
  const result = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')
  return { output: result?.output ?? '', next: requests[1] }
}

const toolTurn = (req: ChatRequest) => req.messages.find((m) => m.role === 'tool')

describe('read_file attachments follow the route', () => {
  it('attaches a PDF on a Claude host', async () => {
    const { output, next } = await readThrough('anthropic', 'claude-sonnet-5', 'spec.pdf')
    expect(output).toContain('attached below for viewing')
    expect(toolTurn(next)?.documents).toHaveLength(1)
  })

  it('says a PDF could not be viewed on a Chat Completions host, and sends none', async () => {
    const { output, next } = await readThrough('openai-compatible', 'gpt-5.5', 'spec.pdf')
    expect(output).toMatch(/could not be viewed.*pdftotext/)
    expect(toolTurn(next)?.documents ?? []).toHaveLength(0)
  })

  it('attaches an image for a vision model and not for one without vision', async () => {
    const seen = await readThrough('openai-compatible', 'gpt-5.5', 'logo.png')
    expect(seen.output).toContain('attached below for viewing')
    expect(toolTurn(seen.next)?.images).toHaveLength(1)

    const blind = await readThrough('openai-compatible', 'llama3.3', 'logo.png')
    expect(blind.output).toContain('the current model cannot view images')
    expect(toolTurn(blind.next)?.images ?? []).toHaveLength(0)
  })
})
