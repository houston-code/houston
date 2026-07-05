import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatMessage, Provider, ProviderStreamEvent } from '@shared/agent'
import type { Hook } from '@shared/types'
import type { SandboxRunOptions, SandboxRunResult } from '../sandbox'

// Integration coverage for the lifecycle-hook wiring in the agent loop
// (SessionStart / UserPromptSubmit / Stop). The hooks module's own logic is unit
// tested in hooks.test.ts; here we drive startRun with a mocked sandbox runner so
// the loop's control flow (prompt blocking, context injection, Stop-forces-another-
// turn with its bound) is exercised end to end.

const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  settings: { compactionThreshold: 0, permissionRules: [], hooks: [] as Hook[], mcpServers: [], additionalRoots: [] } as Record<string, unknown>,
  // A queue of results per hook command (shifted per call); falls back to static.
  script: {} as Record<string, Array<Partial<SandboxRunResult>>>,
  static: {} as Record<string, Partial<SandboxRunResult>>,
  calls: [] as SandboxRunOptions[]
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'anthropic', kind: 'anthropic', label: 'A', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => [] }))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))
vi.mock('./plugins', () => ({
  loadPlugins: async () => ({ has: () => false, size: 0, emit: async () => {} }),
  loadPluginsIfEnabled: async () => ({ has: () => false, size: 0, emit: async () => {} })
}))
// Fake the sandbox runner so hooks don't spawn real processes; keep every other
// sandbox export real (isSandboxed etc.) so the loop's approval logic is unchanged.
vi.mock('../sandbox', async (importActual) => {
  const actual = await importActual<typeof import('../sandbox')>()
  return {
    ...actual,
    runSandboxed: async (o: SandboxRunOptions): Promise<SandboxRunResult> => {
      h.calls.push(o)
      const queued = h.script[o.command]?.shift()
      const r = queued ?? h.static[o.command] ?? {}
      return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0, timedOut: false, sandboxed: true }
    }
  }
})

const { startRun } = await import('./loop')

/** A provider that replays one pre-scripted turn per streamChat call. */
function scripted(turns: ProviderStreamEvent[][]): Provider & { calls: number } {
  const p = {
    calls: 0,
    async *streamChat() {
      const turn = turns[p.calls++] ?? [{ type: 'done', stopReason: 'end_turn' } as ProviderStreamEvent]
      for (const ev of turn) yield ev
    }
  }
  return p
}

let ws: string
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-loophooks-'))
  h.settings.hooks = []
  h.script = {}
  h.static = {}
  h.calls = []
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function run(opts: { turns?: ProviderStreamEvent[][]; provider?: Provider; userText?: string }): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> {
  h.provider = opts.provider ?? scripted(opts.turns ?? [])
  const events: AgentEvent[] = []
  let messages: ChatMessage[] = []
  await startRun(
    {
      runId: `run-${events.length}-${ws.length}`,
      workspace: ws,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask',
      messages: [{ role: 'user', content: opts.userText ?? 'do it' }]
    },
    (e) => events.push(e),
    (m) => {
      messages = m
    }
  )
  return { events, messages }
}

describe('lifecycle hooks in the loop', () => {
  it('UserPromptSubmit hook blocks the prompt (no turn runs)', async () => {
    h.settings.hooks = [{ event: 'UserPromptSubmit', matcher: '*', command: 'guard' }]
    h.static = { guard: { exitCode: 1, stdout: 'prompt looks unsafe' } }
    const provider = scripted([[{ type: 'text', text: 'should not run' }, { type: 'done', stopReason: 'end_turn' }]])
    const { events } = await run({ provider })
    const error = events.find((e) => e.type === 'error')
    expect(error && 'message' in error ? error.message : '').toContain('UserPromptSubmit')
    expect(events.some((e) => e.type === 'done')).toBe(false)
    expect(provider.calls).toBe(0) // the model was never called
  })

  it('UserPromptSubmit hook injects context into the user message', async () => {
    h.settings.hooks = [{ event: 'UserPromptSubmit', matcher: '*', command: 'ctx' }]
    h.static = { ctx: { stdout: JSON.stringify({ additionalContext: 'note: CI is currently red' }) } }
    const { messages } = await run({ userText: 'fix the bug', turns: [[{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]] })
    const firstUser = messages.find((m) => m.role === 'user')
    expect(typeof firstUser?.content === 'string' && firstUser.content).toContain('fix the bug')
    expect(typeof firstUser?.content === 'string' && firstUser.content).toContain('CI is currently red')
  })

  it('Stop hook forces another turn, then lets the agent finish', async () => {
    h.settings.hooks = [{ event: 'Stop', matcher: '*', command: 'check' }]
    // First Stop blocks (keep working); second allows the turn to end.
    h.script = { check: [{ exitCode: 1, stdout: 'run the tests before stopping' }, { exitCode: 0 }] }
    const provider = scripted([
      [{ type: 'text', text: 'first' }, { type: 'done', stopReason: 'end_turn' }],
      [{ type: 'text', text: 'second' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const { events, messages } = await run({ provider })
    expect(provider.calls).toBe(2) // the block drove a second model turn
    const injected = messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('run the tests'))
    expect(injected).toHaveLength(1)
    const assistantText = messages.filter((m) => m.role === 'assistant').map((m) => m.content)
    expect(assistantText).toContain('second')
    expect(events.at(-1)?.type).toBe('done')
  })

  it('Stop hook continuation is bounded (cannot loop forever)', async () => {
    h.settings.hooks = [{ event: 'Stop', matcher: '*', command: 'always' }]
    h.static = { always: { exitCode: 1, stdout: 'keep going' } } // always blocks
    const { events, messages } = await run({ turns: [[{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]] })
    const injected = messages.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('keep going'))
    expect(injected).toHaveLength(3) // MAX_STOP_CONTINUATIONS
    expect(events.at(-1)?.type).toBe('done')
  })
})
