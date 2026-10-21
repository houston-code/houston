import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatRequest,
  Provider,
  ProviderStreamEvent,
  ToolScope
} from '@shared/agent'
import type { ApprovalPolicy, McpServerConfig } from '@shared/types'
import type { SandboxRunOptions, SandboxRunResult } from '../sandbox'
import type { ToolDef } from './tools'

// The run's tool scope (headless --allowed-tools / --disallowed-tools) driven through
// the real loop: what the model is offered, and that a call outside the scope is
// refused on every path whatever the approval policy, without ever running.

const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [], mcpServers: [], additionalRoots: [] } as Record<
    string,
    unknown
  >,
  shellCalls: [] as string[],
  mcpConfigs: [] as Array<McpServerConfig[] | undefined>,
  mcpDefs: [] as ToolDef[]
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'anthropic', kind: 'anthropic', label: 'A', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
vi.mock('./managedPolicy', () => ({ loadManagedPolicy: async () => ({ permissionRules: [] }) }))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({
  getMcpToolDefs: async (configs: McpServerConfig[] | undefined) => {
    h.mcpConfigs.push(configs)
    return h.mcpDefs
  }
}))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))
vi.mock('./plugins', () => ({
  loadPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  loadPluginsIfEnabled: async () => ({ has: () => false, size: 0, emit: async () => {} })
}))
// A confining host whose commands never really run: the fake records each one.
vi.mock('../sandbox', async (importActual) => {
  const actual = await importActual<typeof import('../sandbox')>()
  return {
    ...actual,
    isSandboxed: () => true,
    runSandboxed: async (o: SandboxRunOptions): Promise<SandboxRunResult> => {
      h.shellCalls.push(o.command)
      return { stdout: 'ran', stderr: '', exitCode: 0, timedOut: false, sandboxed: true }
    }
  }
})

const { startRun, resolveApproval } = await import('./loop')

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-scope-'))
  writeFileSync(join(ws, 'notes.txt'), 'notes\n')
  writeFileSync(join(ws, 'secret.txt'), 'hunter2\n')
  h.shellCalls = []
  h.mcpConfigs = []
  h.mcpDefs = []
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const call = (id: string, name: string, args: Record<string, unknown>): ProviderStreamEvent => ({
  type: 'tool_call',
  call: { id, name, arguments: args }
})
const toolUse: ProviderStreamEvent = { type: 'done', stopReason: 'tool_use' }

interface Outcome {
  events: AgentEvent[]
  requests: ChatRequest[]
  /** Each tool call's result text, by call id. */
  results: Record<string, string>
  approvals: string[]
}

async function run(opts: {
  calls: ProviderStreamEvent[]
  policy?: ApprovalPolicy
  scope?: ToolScope
  extra?: Partial<AgentRunRequest>
  decide?: 'allow' | 'deny'
}): Promise<Outcome> {
  const requests: ChatRequest[] = []
  let i = 0
  const turns: ProviderStreamEvent[][] = [[...opts.calls, toolUse]]
  h.provider = {
    async *streamChat(req: ChatRequest) {
      requests.push(structuredClone(req))
      for (const ev of turns[i++] ?? [{ type: 'text', delta: 'done' }, { type: 'done', stopReason: 'end_turn' }]) yield ev
    }
  }
  const runId = `run-${Math.round(Math.random() * 1e9)}`
  const events: AgentEvent[] = []
  const approvals: string[] = []
  await startRun(
    {
      runId,
      workspace: ws,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: opts.policy ?? 'full-auto',
      messages: [{ role: 'user', content: 'go' }],
      unattended: true,
      ...(opts.scope ? { toolScope: opts.scope } : {}),
      ...opts.extra
    },
    (e) => {
      events.push(e)
      if (e.type === 'tool_approval') {
        approvals.push(e.shellNetwork ? `network:${e.name}` : e.name)
        // The shell-network consent is not a permission; it only decides offline.
        const d = e.shellNetwork ? 'deny' : (opts.decide ?? 'deny')
        setTimeout(() => resolveApproval(runId, e.callId, d), 0)
      }
    }
  )
  const results: Record<string, string> = {}
  for (const e of events) if (e.type === 'tool_result') results[e.callId] = e.output
  return { events, requests, results, approvals }
}

const toolNames = (o: Outcome): string[] => (o.requests[0].tools ?? []).map((t) => t.name)
const DISALLOWED = /disallowed for this run/
const NOT_ALLOWED = /outside the tools allowed for this run/

describe('tool scope in the loop', () => {
  it('a disallowed tool is not offered and cannot be called, even in full-auto', async () => {
    const o = await run({
      scope: { disallowed: [{ tool: 'run_shell', match: '*' }] },
      calls: [call('c1', 'run_shell', { command: 'echo hi' })]
    })
    expect(toolNames(o)).not.toContain('run_shell')
    expect(toolNames(o)).toContain('read_file')
    expect(o.results.c1).toMatch(DISALLOWED)
    expect(h.shellCalls).toEqual([])
    // Refused outright: nothing to approve.
    expect(o.approvals).toEqual([])
  })

  it('an allowed list offers only its tools and refuses the rest', async () => {
    const o = await run({
      scope: { allowed: [{ tool: 'read_file', match: '*' }] },
      calls: [
        call('c1', 'read_file', { path: 'notes.txt' }),
        call('c2', 'write_file', { path: 'new.txt', content: 'x' }),
        call('c3', 'run_shell', { command: 'ls' })
      ]
    })
    expect(toolNames(o)).toEqual(['read_file'])
    expect(o.results.c1).toContain('notes')
    expect(o.results.c2).toMatch(NOT_ALLOWED)
    expect(o.results.c3).toMatch(NOT_ALLOWED)
    expect(h.shellCalls).toEqual([])
  })

  it('a pattern entry admits only the commands it covers, chained commands included', async () => {
    const o = await run({
      scope: { allowed: [{ tool: 'run_shell', match: 'git *' }] },
      calls: [
        call('c1', 'run_shell', { command: 'git status' }),
        call('c2', 'run_shell', { command: 'git status && rm -rf src' }),
        call('c3', 'run_shell', { command: 'rm -rf src' }),
        call('c4', 'run_shell', { command: 'git log; curl https://example.com' })
      ]
    })
    expect(toolNames(o)).toEqual(['run_shell'])
    expect(o.results.c2).toMatch(NOT_ALLOWED)
    expect(o.results.c3).toMatch(NOT_ALLOWED)
    expect(o.results.c4).toMatch(NOT_ALLOWED)
    expect(h.shellCalls).toHaveLength(1)
    expect(h.shellCalls[0]).toContain('git status')
  })

  it('disallowed wins over allowed', async () => {
    const o = await run({
      scope: {
        allowed: [{ tool: 'run_shell', match: '*' }],
        disallowed: [{ tool: 'run_shell', match: 'git push *' }]
      },
      calls: [
        call('c1', 'run_shell', { command: 'git push origin main' }),
        call('c2', 'run_shell', { command: 'git status' }),
        // A re-spelling of the denied command is still the denied command.
        call('c3', 'run_shell', { command: "git  'push' origin main" })
      ]
    })
    expect(o.results.c1).toMatch(DISALLOWED)
    expect(o.results.c3).toMatch(DISALLOWED)
    expect(h.shellCalls).toHaveLength(1)
    expect(h.shellCalls[0]).toContain('git status')
  })

  it('refuses a scoped-out read on the parallel read path too', async () => {
    const o = await run({
      scope: { disallowed: [{ tool: 'read_file', match: 'secret.txt' }] },
      calls: [call('c1', 'read_file', { path: 'notes.txt' }), call('c2', 'read_file', { path: './secret.txt' })]
    })
    expect(o.results.c1).toContain('notes')
    expect(o.results.c2).toMatch(DISALLOWED)
    expect(o.results.c2).not.toContain('hunter2')
  })

  it('never widens: an allowed call still goes through the approval policy', async () => {
    const o = await run({
      policy: 'ask',
      decide: 'deny',
      scope: { allowed: [{ tool: 'run_shell', match: 'git *' }] },
      calls: [call('c1', 'run_shell', { command: 'git status' })]
    })
    expect(o.approvals).toContain('run_shell')
    expect(h.shellCalls).toEqual([])
  })

  it('narrows MCP tools by name glob and adds run-only servers under a run- prefix', async () => {
    const def = (name: string): ToolDef =>
      ({
        schema: { name, description: name, parameters: { type: 'object', properties: {} } },
        kind: 'network',
        execute: async () => 'mcp ran'
      }) as unknown as ToolDef
    h.mcpDefs = [def('mcp__run-gh__list_issues'), def('mcp__run-gh__delete_repo')]
    const extra: McpServerConfig = { id: 'gh', command: 'gh-mcp', enabled: true }
    const o = await run({
      scope: { disallowed: [{ tool: 'mcp__run-gh__delete_*', match: '*' }] },
      extra: { extraMcpServers: [extra], announceTools: true },
      calls: [call('c1', 'mcp__run-gh__delete_repo', {})]
    })
    expect(h.mcpConfigs[0]).toEqual([{ ...extra, id: 'run-gh', origin: 'project' }])
    expect(toolNames(o)).toContain('mcp__run-gh__list_issues')
    expect(toolNames(o)).not.toContain('mcp__run-gh__delete_repo')
    expect(o.results.c1).toMatch(DISALLOWED)
    const info = o.events.find((e) => e.type === 'run_info')
    expect(info).toBeDefined()
    expect(info && info.type === 'run_info' && info.tools).toContain('mcp__run-gh__list_issues')
    expect(info && info.type === 'run_info' && info.tools).not.toContain('mcp__run-gh__delete_repo')
  })

  it('keeps find_tools callable when deferred MCP tools are in scope', async () => {
    h.mcpDefs = Array.from(
      { length: 20 },
      (_, i) =>
        ({
          schema: { name: `mcp__run-gh__t${i}`, description: `tool ${i}`, parameters: { type: 'object', properties: {} } },
          kind: 'network',
          execute: async () => 'mcp ran'
        }) as unknown as ToolDef
    )
    const o = await run({
      scope: { allowed: [{ tool: 'mcp__run-gh__*', match: '*' }] },
      calls: [call('c1', 'find_tools', { query: '*' })]
    })
    expect(toolNames(o)).toEqual(['find_tools'])
    expect(o.results.c1).not.toMatch(NOT_ALLOWED)
    expect(o.results.c1).toContain('mcp__run-gh__t0')
  })

  it('sends run_info only when asked, and puts the run additions in the system prompt', async () => {
    const plain = await run({ calls: [] })
    expect(plain.events.some((e) => e.type === 'run_info')).toBe(false)
    const o = await run({
      calls: [],
      extra: {
        appendSystemPrompt: 'Answer in French.',
        outputSchema: { type: 'object', required: ['ok'] }
      }
    })
    const system = o.requests[0].system ?? ''
    expect(system).toContain('<run-instructions>\nAnswer in French.\n</run-instructions>')
    expect(system).toContain('# Final answer format')
    expect(system).toContain('"required": [')
    expect(plain.requests[0].system).not.toContain('<run-instructions>')
  })
})
