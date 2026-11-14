import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatRequest, Provider } from '@shared/agent'

// The run start's independent loads (project rules, managed policy, project config,
// agents, skills, the prompt snapshot's git context, the sandbox backend) run at once,
// and the MCP servers connect as soon as the project config is known. Each load here
// waits on a gate the test opens, so the order they start and finish in is the test's.

const h = vi.hoisted(() => ({
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [], mcpServers: [], additionalRoots: [] } as Record<string, unknown>,
  /** Closed gates by load name; a load without one finishes at once. */
  gates: {} as Record<string, { promise: Promise<void>; open: () => void }>,
  log: [] as string[],
  rulesOpts: undefined as unknown,
  failRules: false,
  mcpCalls: 0,
  requests: [] as ChatRequest[]
}))

async function gate(name: string): Promise<void> {
  h.log.push(`start:${name}`)
  await h.gates[name]?.promise
  h.log.push(`end:${name}`)
}

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'anthropic', kind: 'anthropic', label: 'A', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
vi.mock('../providers', () => ({
  createProvider: (): Provider => ({
    async *streamChat(req: ChatRequest) {
      h.requests.push(req)
      yield { type: 'text', text: 'ok' }
      yield { type: 'done', stopReason: 'end_turn' }
    }
  })
}))
vi.mock('../mcp/manager', () => ({
  getMcpToolDefs: async () => {
    h.mcpCalls++
    h.log.push('mcp')
    return []
  },
  releaseMcpRun: () => {}
}))
vi.mock('./rules', async (importActual) => ({
  ...(await importActual<typeof import('./rules')>()),
  loadProjectRules: async (_ws: string, opts: unknown) => {
    h.rulesOpts = opts
    await gate('rules')
    if (h.failRules) throw new Error('rules unreadable')
    return { text: 'Project rules text.', files: ['AGENTS.md'], truncated: [] }
  }
}))
vi.mock('./managedPolicy', () => ({
  loadManagedPolicy: async () => {
    await gate('policy')
    return { permissionRules: [] }
  }
}))
vi.mock('./projectConfig', async (importActual) => {
  const actual = await importActual<typeof import('./projectConfig')>()
  return {
    ...actual,
    loadProjectConfig: async (ws: string) => {
      await gate('config')
      return actual.loadProjectConfig(ws)
    }
  }
})
vi.mock('./agents', async (importActual) => {
  const actual = await importActual<typeof import('./agents')>()
  return {
    ...actual,
    loadAgents: async (ws: string) => {
      await gate('agents')
      return actual.loadAgents(ws, '/nonexistent-houston-preamble-home')
    }
  }
})
vi.mock('./skills', async (importActual) => {
  const actual = await importActual<typeof import('./skills')>()
  return {
    ...actual,
    loadSkills: async (ws: string) => {
      await gate('skills')
      return actual.loadSkills(ws, '/nonexistent-houston-preamble-home')
    }
  }
})
vi.mock('./git', () => ({
  gitContext: async () => {
    await gate('git')
    return 'Git: on branch "main" — working tree clean.'
  }
}))
vi.mock('./github', async (importActual) => ({
  ...(await importActual<typeof import('./github')>()),
  githubContext: () => ''
}))
vi.mock('../sandbox', async (importActual) => {
  const actual = await importActual<typeof import('../sandbox')>()
  return {
    ...actual,
    prepareSandbox: async () => {
      await gate('sandbox')
    },
    activeBackendId: () => {
      h.log.push('backend')
      return 'seatbelt'
    }
  }
})
vi.mock('./plugins', async (importActual) => {
  const actual = await importActual<typeof import('./plugins')>()
  const emptyHost = { has: () => false, size: 0, emit: async () => {} }
  return {
    readPluginFiles: actual.readPluginFiles,
    loadPlugins: async () => emptyHost,
    loadTrustedPlugins: async () => emptyHost
  }
})
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))

const { startRun } = await import('./loop')

const LOADS = ['rules', 'policy', 'config', 'agents', 'skills', 'git', 'sandbox']

function closeGates(names: string[] = LOADS): void {
  for (const name of names) {
    let open = (): void => {}
    const promise = new Promise<void>((resolve) => (open = resolve))
    h.gates[name] = { promise, open }
  }
}
function openGate(name: string): void {
  h.gates[name]?.open()
}
const started = (): string[] => h.log.filter((l) => l.startsWith('start:')).map((l) => l.slice(6))
const ended = (): string[] => h.log.filter((l) => l.startsWith('end:')).map((l) => l.slice(4))
/** Let every continuation that can run, run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-preamble-'))
  h.gates = {}
  h.log = []
  h.rulesOpts = undefined
  h.failRules = false
  h.mcpCalls = 0
  h.requests = []
})
afterEach(() => {
  for (const name of LOADS) openGate(name)
  rmSync(ws, { recursive: true, force: true })
})

function start(): { events: AgentEvent[]; done: Promise<void> } {
  const events: AgentEvent[] = []
  const done = startRun(
    {
      runId: `run-${Math.round(Math.random() * 1e9)}`,
      workspace: ws,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask',
      messages: [{ role: 'user', content: 'hello' }]
    },
    (e) => events.push(e),
    () => {}
  )
  return { events, done }
}

describe('run start', () => {
  it('starts every independent load at once, before any of them finishes', async () => {
    closeGates()
    const run = start()
    await vi.waitFor(() => expect([...started()].sort()).toEqual([...LOADS].sort()))
    expect(ended()).toEqual([])
    // Nothing reads the sandbox backend (the prompt names it) before it is chosen.
    expect(h.log).not.toContain('backend')
    for (const name of LOADS) openGate(name)
    await run.done
    expect(run.events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' })
    expect(h.log.indexOf('backend')).toBeGreaterThan(h.log.indexOf('end:sandbox'))
    // The rules load reuses the nested-rules listing across turns.
    expect(h.rulesOpts).toEqual({ reuseDiscovery: true })
  })

  it('connects the MCP servers as soon as the project config is known', async () => {
    closeGates()
    const run = start()
    await vi.waitFor(() => expect(started()).toContain('config'))
    await settle()
    expect(h.mcpCalls).toBe(0)
    openGate('config')
    await vi.waitFor(() => expect(h.mcpCalls).toBe(1))
    // The rest are still loading: the connect overlaps them.
    expect(ended()).toEqual(['config'])
    for (const name of LOADS) openGate(name)
    await run.done
    expect(h.mcpCalls).toBe(1)
  })

  it('sends the same system prompt and tools whichever load finishes first', async () => {
    const runInOrder = async (order: string[]): Promise<ChatRequest> => {
      h.requests = []
      closeGates()
      const run = start()
      await vi.waitFor(() => expect(started().length).toBeGreaterThanOrEqual(LOADS.length))
      for (const name of order) {
        openGate(name)
        await settle()
      }
      await run.done
      expect(h.requests).toHaveLength(1)
      return h.requests[0]
    }
    const forward = await runInOrder(LOADS)
    h.log = []
    const backward = await runInOrder([...LOADS].reverse())
    expect(forward.system).toContain('Project rules text.')
    expect(forward.system).toContain('Git: on branch "main"')
    expect(backward.system).toBe(forward.system)
    expect(backward.tools).toEqual(forward.tools)
  })

  it('registers no MCP servers for a run whose start failed before the project config was known', async () => {
    closeGates(['config', 'agents', 'skills', 'git', 'sandbox', 'policy'])
    h.failRules = true
    const run = start()
    await run.done
    expect(run.events.at(-1)).toMatchObject({ type: 'error' })
    // The project config arrives after the run released its servers.
    openGate('config')
    await settle()
    expect(h.mcpCalls).toBe(0)
  })
})
