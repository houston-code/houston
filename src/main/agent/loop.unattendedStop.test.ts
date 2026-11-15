import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import type { ApprovalPolicy } from '@shared/types'
import { MAX_UNATTENDED_STOP_CONTINUATIONS, UNATTENDED_STOP_NOTE } from './unattended-stop'

// An unattended run that ends its turn on announced-but-undone work is sent back
// with a note, a bounded number of times; an attended run hands back as before.

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
  loadTrustedPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  readPluginFiles: async () => ({ files: [], skipped: [] })
}))

const { startRun } = await import('./loop')

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-unattended-stop-'))
})
afterEach(() => rmSync(ws, { recursive: true, force: true }))

const say = (text: string): ProviderStreamEvent[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'end_turn' }
]

async function run(
  replies: string[],
  opts: { unattended?: boolean; policy?: ApprovalPolicy } = {}
): Promise<{ requests: ChatRequest[]; events: AgentEvent[] }> {
  const requests: ChatRequest[] = []
  let i = 0
  h.provider = {
    async *streamChat(req: ChatRequest) {
      requests.push(structuredClone(req))
      for (const ev of say(replies[Math.min(i++, replies.length - 1)])) yield ev
    }
  }
  const events: AgentEvent[] = []
  await startRun(
    {
      runId: `run-${Math.round(Math.random() * 1e9)}`,
      workspace: ws,
      providerId: 'p',
      model: 'claude-sonnet-5',
      approvalPolicy: opts.policy ?? 'full-auto',
      messages: [{ role: 'user', content: 'solve it' }],
      ...(opts.unattended === false ? {} : { unattended: true })
    },
    (e) => events.push(e)
  )
  return { requests, events }
}

const notes = (req: ChatRequest): number =>
  req.messages.filter((m) => typeof m.content === 'string' && m.content.includes(UNATTENDED_STOP_NOTE)).length

describe('unattended runs that stop on undone work', () => {
  it('sends the turn back once, then ends when the reply is finished', async () => {
    const { requests, events } = await run(["Next I'll write the solver.", 'Wrote and tested solution.cpp. All checks pass.'])
    expect(requests).toHaveLength(2)
    expect(notes(requests[1])).toBe(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' })
    // Clients are told the first reply was sent back, between the two replies.
    const kinds = events.map((e) => e.type)
    const back = kinds.indexOf('reply_sent_back')
    expect(back).toBeGreaterThan(kinds.indexOf('text'))
    expect(back).toBeLessThan(kinds.lastIndexOf('text'))
    expect(kinds.filter((k) => k === 'reply_sent_back')).toHaveLength(1)
  })

  it('stops sending it back after the bound, so a model that keeps asking cannot loop', async () => {
    const { requests } = await run(['Should I continue?'])
    expect(requests).toHaveLength(1 + MAX_UNATTENDED_STOP_CONTINUATIONS)
    expect(notes(requests.at(-1)!)).toBe(MAX_UNATTENDED_STOP_CONTINUATIONS)
  })

  it('leaves an attended run alone: a person is there to answer', async () => {
    const { requests } = await run(['Should I continue?'], { unattended: false })
    expect(requests).toHaveLength(1)
  })

  it('leaves plan mode alone: proposing next steps is the deliverable there', async () => {
    const { requests } = await run(['Next step: implement the parser.'], { policy: 'plan' })
    expect(requests).toHaveLength(1)
  })

  it('does not send back a finished reply', async () => {
    const { requests, events } = await run(['Fixed it; the tests pass.'])
    expect(requests).toHaveLength(1)
    expect(events.some((e) => e.type === 'reply_sent_back')).toBe(false)
  })
})
