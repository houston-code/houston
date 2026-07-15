import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatMessage, Provider, ProviderStreamEvent, ToolApprovalDecision } from '@shared/agent'
import type { Hook, PermissionRule } from '@shared/types'
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
  calls: [] as SandboxRunOptions[],
  // Admin managed-policy rules (highest-precedence, tighten-only tier), injected
  // through the `./managedPolicy` mock below; default none.
  managedRules: [] as PermissionRule[]
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: () => {},
  getProvider: () => ({ id: 'anthropic', kind: 'anthropic', label: 'A', models: [], requiresKey: false, hasKey: true, builtIn: true }),
  getKey: () => null,
  collectSecrets: () => []
}))
// The admin managed policy normally reads a fixed root-owned system path; in tests
// we inject its rules through the hoisted holder instead of touching the real path.
vi.mock('./managedPolicy', () => ({
  loadManagedPolicy: async () => ({ permissionRules: h.managedRules })
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

const { startRun, resolveApproval } = await import('./loop')

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
  h.settings.permissionRules = []
  h.script = {}
  h.static = {}
  h.calls = []
  h.managedRules = []
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function run(opts: {
  turns?: ProviderStreamEvent[][]
  provider?: Provider
  userText?: string
  onApproval?: (callId: string, decide: (d: ToolApprovalDecision) => void) => void
}): Promise<{ events: AgentEvent[]; messages: ChatMessage[] }> {
  h.provider = opts.provider ?? scripted(opts.turns ?? [])
  const runId = `run-${Math.round(Math.random() * 1e9)}`
  const events: AgentEvent[] = []
  let messages: ChatMessage[] = []
  await startRun(
    {
      runId,
      workspace: ws,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: 'ask',
      messages: [{ role: 'user', content: opts.userText ?? 'do it' }]
    },
    (e) => {
      events.push(e)
      if (e.type === 'tool_approval' && opts.onApproval) {
        // Respond on a later tick — the loop registers the approval resolver on the
        // line *after* it emits tool_approval, just as the real renderer replies async.
        setTimeout(() => opts.onApproval!(e.callId, (d) => resolveApproval(runId, e.callId, d)), 0)
      }
    },
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

// A PreToolUse hook may rewrite a call's arguments, which changes what actually
// runs — so the loop must re-match the permission rules against the REWRITTEN
// arguments, not carry over the verdict computed on the model's original ones.
// Otherwise a user-level hook could transform a permitted call into one a managed
// deny covers (the guardrail tiers are tighten-only: user config must never be
// able to loosen them), or keep riding an allow rule the rewrite no longer earns.
describe('PreToolUse rewrites are re-matched against permission rules', () => {
  /** One scripted turn: a single write_file call, then a plain closing turn. */
  const writeTurns = (path: string): ProviderStreamEvent[][] => [
    [
      { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path, content: 'hello' } } },
      { type: 'done', stopReason: 'tool_use' }
    ],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
  ]
  /** A hook stdout directive that rewrites the write to `path`. */
  const rewriteTo = (path: string, extra: Record<string, unknown> = {}): Partial<SandboxRunResult> => ({
    stdout: JSON.stringify({ updatedInput: { path, content: 'rewritten' }, ...extra })
  })
  const toolResult = (events: AgentEvent[]): string => {
    const e = events.find((x) => x.type === 'tool_result')
    return e && 'output' in e ? String(e.output) : ''
  }

  it('a rewrite into a managed deny is refused, even when the hook also approves', async () => {
    h.managedRules = [{ action: 'deny', tool: 'write_file', match: 'secret*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'rw' }]
    // The hook both rewrites the target into denied territory AND tries to
    // auto-approve — the deny must win over the approve.
    h.static = { rw: rewriteTo('secret.txt', { decision: 'approve' }) }
    const { events } = await run({
      turns: writeTurns('ok.txt'),
      onApproval: (_id, decide) => decide('allow') // hang-proofing; must never fire
    })
    expect(events.some((e) => e.type === 'tool_approval')).toBe(false) // denied outright, not prompted
    expect(toolResult(events)).toContain("denied by your organization's managed policy")
    expect(existsSync(join(ws, 'secret.txt'))).toBe(false)
    expect(existsSync(join(ws, 'ok.txt'))).toBe(false)
  })

  it('a rewrite into a user deny rule is refused with the plain-rule message', async () => {
    h.settings.permissionRules = [{ action: 'deny', tool: 'write_file', match: 'secret*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'rw' }]
    h.static = { rw: rewriteTo('secret.txt') }
    // The approval handler must never be needed (deny short-circuits the prompt);
    // it's here so a regression fails the assertions instead of hanging the test.
    const { events } = await run({
      turns: writeTurns('ok.txt'),
      onApproval: (_id, decide) => decide('allow')
    })
    expect(toolResult(events)).toContain('denied by a permission rule')
    expect(toolResult(events)).not.toContain('managed policy')
    expect(existsSync(join(ws, 'secret.txt'))).toBe(false)
  })

  it('an allow rule matching only the original args does not auto-approve the rewrite', async () => {
    h.settings.permissionRules = [{ action: 'allow', tool: 'write_file', match: 'notes*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'rw' }]
    h.static = { rw: rewriteTo('other.txt') }
    const { events } = await run({
      turns: writeTurns('notes.txt'),
      onApproval: (_id, decide) => decide('deny')
    })
    // Without the re-match the stale allow would skip the prompt and write other.txt.
    expect(events.some((e) => e.type === 'tool_approval')).toBe(true)
    expect(toolResult(events)).toContain('Denied by the user')
    expect(existsSync(join(ws, 'other.txt'))).toBe(false)
  })

  it('an allow rule matching the rewritten args auto-approves it', async () => {
    h.settings.permissionRules = [{ action: 'allow', tool: 'write_file', match: 'allowed*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'rw' }]
    h.static = { rw: rewriteTo('allowed.txt') }
    // No prompt is expected; the handler only exists so a regression fails fast.
    const { events } = await run({
      turns: writeTurns('draft.txt'),
      onApproval: (_id, decide) => decide('deny')
    })
    expect(events.some((e) => e.type === 'tool_approval')).toBe(false)
    expect(readFileSync(join(ws, 'allowed.txt'), 'utf8')).toBe('rewritten')
    expect(existsSync(join(ws, 'draft.txt'))).toBe(false)
  })
})
