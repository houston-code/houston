import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  managedRules: [] as PermissionRule[],
  // What isSandboxed() reports. Real hosts differ (macOS confines, Linux CI often
  // doesn't), which changes shell-approval behavior — so tests pin it. Default true
  // (a confining host, the behavior these tests were written against).
  sandboxed: true
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
// Fake the sandbox runner so hooks don't spawn real processes, and pin isSandboxed
// so shell-approval behavior doesn't vary by host; every other sandbox export stays
// real so the loop's approval logic is otherwise unchanged.
vi.mock('../sandbox', async (importActual) => {
  const actual = await importActual<typeof import('../sandbox')>()
  return {
    ...actual,
    isSandboxed: () => h.sandboxed,
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
  h.sandboxed = true
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function run(opts: {
  turns?: ProviderStreamEvent[][]
  provider?: Provider
  userText?: string
  messages?: ChatMessage[]
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
      messages: opts.messages ?? [{ role: 'user', content: opts.userText ?? 'do it' }]
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

// A hook's `systemMessage` directive is a note for the user, not the agent: the
// loop surfaces it as a 'notice' event (rendered by every client) and it must
// never land in the message log the model reads from.
describe('hook systemMessage → user-facing notice', () => {
  const notices = (events: AgentEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'notice' ? [e.message] : []))
  const sysMsg = (text: string): Partial<SandboxRunResult> => ({
    stdout: JSON.stringify({ systemMessage: text })
  })
  const plainTurn: ProviderStreamEvent[][] = [
    [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
  ]

  it('SessionStart emits the note', async () => {
    h.settings.hooks = [{ event: 'SessionStart', matcher: '*', command: 'ss' }]
    h.static = { ss: sysMsg('session note') }
    const { events } = await run({ turns: plainTurn })
    expect(notices(events)).toEqual(['session note'])
  })

  it('UserPromptSubmit emits the note even when the hook also blocks the prompt', async () => {
    h.settings.hooks = [{ event: 'UserPromptSubmit', matcher: '*', command: 'ups' }]
    h.static = { ups: { stdout: JSON.stringify({ decision: 'block', systemMessage: 'prompt vetoed by policy' }) } }
    const { events } = await run({ turns: plainTurn })
    expect(notices(events)).toEqual(['prompt vetoed by policy'])
    expect(events.some((e) => e.type === 'error')).toBe(true) // the block still lands
  })

  it('Stop emits the note', async () => {
    h.settings.hooks = [{ event: 'Stop', matcher: '*', command: 'stop' }]
    h.static = { stop: sysMsg('turn ended') }
    const { events } = await run({ turns: plainTurn })
    expect(notices(events)).toEqual(['turn ended'])
  })

  it('PreToolUse and PostToolUse emit their notes, and neither reaches the model context', async () => {
    h.settings.hooks = [
      { event: 'PreToolUse', matcher: 'write_file', command: 'pre' },
      { event: 'PostToolUse', matcher: 'write_file', command: 'post' }
    ]
    h.static = { pre: sysMsg('pre note'), post: sysMsg('post note') }
    const { events, messages } = await run({
      turns: writeTurns('a.txt'),
      onApproval: (_id, decide) => decide('allow')
    })
    expect(notices(events)).toEqual(['pre note', 'post note'])
    // The documented contract: the note is for the user only. Nothing the model
    // reads — the persisted log (tool results included) — may carry it.
    const log = messages.map((m) => m.content).join('\n')
    expect(log).not.toContain('pre note')
    expect(log).not.toContain('post note')
  })

  it('PreCompact emits the note when compaction runs', async () => {
    h.settings.hooks = [{ event: 'PreCompact', matcher: '*', command: 'pc' }]
    h.static = { pc: sysMsg('state saved before compaction') }
    // Enough history to have older turns to fold away; the first main send
    // overflows, forcing the reactive compaction path (threshold stays 0).
    const history: ChatMessage[] = []
    for (let t = 0; t < 4; t++) {
      history.push({ role: 'user', content: `old question ${t}` })
      history.push({ role: 'assistant', content: `old answer ${t}` })
    }
    history.push({ role: 'user', content: 'current question' })
    let mainCalls = 0
    const provider: Provider = {
      async *streamChat(req) {
        // Summarization calls are the only ones that set maxTokens.
        if (req.maxTokens != null) {
          yield { type: 'text', text: 'SUMMARY' }
          yield { type: 'done', stopReason: 'end_turn' }
          return
        }
        mainCalls++
        if (mainCalls === 1) {
          yield { type: 'error', message: 'prompt is too long: 212129 tokens > 200000 maximum' }
          return
        }
        yield { type: 'text', text: 'recovered' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const { events } = await run({ provider, messages: history })
    expect(events.some((e) => e.type === 'compaction')).toBe(true)
    expect(notices(events)).toEqual(['state saved before compaction'])
  })

  it('emits nothing when no hook sets systemMessage', async () => {
    h.settings.hooks = [{ event: 'Stop', matcher: '*', command: 'quiet' }]
    h.static = { quiet: { stdout: JSON.stringify({ reason: 'all good' }) } }
    const { events } = await run({ turns: plainTurn })
    expect(notices(events)).toEqual([])
  })

  it('concatenates notes from multiple hooks on the same event', async () => {
    h.settings.hooks = [
      { event: 'Stop', matcher: '*', command: 'one' },
      { event: 'Stop', matcher: '*', command: 'two' }
    ]
    h.static = { one: sysMsg('first note'), two: sysMsg('second note') }
    const { events } = await run({ turns: plainTurn })
    expect(notices(events)).toEqual(['first note\nsecond note'])
  })
})

// A PreToolUse hook may rewrite a call's arguments, which changes what actually
// runs — so the loop must re-match the permission rules against the REWRITTEN
// arguments, not carry over the verdict computed on the model's original ones.
// Otherwise a user-level hook could transform a permitted call into one a managed
// deny covers (the guardrail tiers are tighten-only: user config must never be
// able to loosen them), or keep riding an allow rule the rewrite no longer earns.
describe('PreToolUse rewrites are re-matched against permission rules', () => {
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

// A PreToolUse hook's `{decision:"approve"}` skips the approval prompt — but only
// a prompt the user's own config or the coarse policy asked for. An `ask` mandated
// by the managed policy or the project guardrails is tighten-only territory: hooks
// are user-level config, so the directive must never suppress a prompt an admin or
// the project explicitly required.
describe('hook approve cannot skip a guardrail-mandated ask', () => {
  /** A hook that only approves (no rewrite). */
  const approve: Partial<SandboxRunResult> = { stdout: JSON.stringify({ decision: 'approve' }) }

  it('a managed-policy ask rule still prompts when the hook approves', async () => {
    h.managedRules = [{ action: 'ask', tool: 'write_file', match: 'guarded*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'ok' }]
    h.static = { ok: approve }
    const { events } = await run({
      turns: writeTurns('guarded.txt'),
      onApproval: (_id, decide) => decide('deny')
    })
    // Without the guardrail re-check the hook's approve skips the prompt entirely.
    expect(events.some((e) => e.type === 'tool_approval')).toBe(true)
    expect(toolResult(events)).toContain('Denied by the user')
    expect(existsSync(join(ws, 'guarded.txt'))).toBe(false)
  })

  it('a project-guardrail ask rule still prompts, and an allow proceeds normally', async () => {
    mkdirSync(join(ws, '.houston'), { recursive: true })
    writeFileSync(
      join(ws, '.houston', 'settings.json'),
      JSON.stringify({ permissionRules: [{ action: 'ask', tool: 'write_file', match: 'guarded*' }] })
    )
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'ok' }]
    h.static = { ok: approve }
    const { events } = await run({
      turns: writeTurns('guarded.txt'),
      onApproval: (_id, decide) => decide('allow')
    })
    expect(events.some((e) => e.type === 'tool_approval')).toBe(true)
    // The forced prompt is real and binding, not a dead end — allowing it runs the call.
    expect(readFileSync(join(ws, 'guarded.txt'), 'utf8')).toBe('hello')
  })

  it("a user-tier ask rule stays skippable by the user's own hook", async () => {
    h.settings.permissionRules = [{ action: 'ask', tool: 'write_file', match: 'guarded*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'ok' }]
    h.static = { ok: approve }
    // The deny handler is hang-proofing: if a prompt wrongly fires, the write is
    // denied and the file assertion fails instead of the test hanging.
    const { events } = await run({
      turns: writeTurns('guarded.txt'),
      onApproval: (_id, decide) => decide('deny')
    })
    expect(events.some((e) => e.type === 'tool_approval')).toBe(false)
    expect(readFileSync(join(ws, 'guarded.txt'), 'utf8')).toBe('hello')
  })

  it('a rewrite into managed-ask territory prompts on the rewritten args despite the approve', async () => {
    h.managedRules = [{ action: 'ask', tool: 'write_file', match: 'guarded*' }]
    h.settings.hooks = [{ event: 'PreToolUse', matcher: 'write_file', command: 'rw' }]
    // Original args match no rule; only the rewritten path lands on the managed ask.
    h.static = { rw: rewriteTo('guarded.txt', { decision: 'approve' }) }
    const { events } = await run({
      turns: writeTurns('free.txt'),
      onApproval: (_id, decide) => decide('deny')
    })
    expect(events.some((e) => e.type === 'tool_approval')).toBe(true)
    expect(toolResult(events)).toContain('Denied by the user')
    expect(existsSync(join(ws, 'guarded.txt'))).toBe(false)
    expect(existsSync(join(ws, 'free.txt'))).toBe(false)
  })
})

// On a host with no enforceable OS sandbox, every shell command prompts until the
// user picks "Allow for run" on an unconfined-shell prompt (the per-run consent,
// run.shellUnsandboxedOverride). That consent stops the *default* every-command
// prompt — it must not silence a permission `ask` rule. The managed/project tiers
// are tighten-only, and even the user's own ask rule already survives a generic
// override on a confining host, so this consent gets no more power than that.
describe('unconfined-shell override cannot skip an ask rule', () => {
  /** One turn issuing two sequential shell commands, then a closing turn. */
  const shellTurns = (first: string, second: string): ProviderStreamEvent[][] => [
    [
      { type: 'tool_call', call: { id: 's1', name: 'run_shell', arguments: { command: first } } },
      { type: 'tool_call', call: { id: 's2', name: 'run_shell', arguments: { command: second } } },
      { type: 'done', stopReason: 'tool_use' }
    ],
    [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
  ]
  const prompts = (events: AgentEvent[]): AgentEvent[] =>
    events.filter((e) => e.type === 'tool_approval')
  const resultFor = (events: AgentEvent[], callId: string): string => {
    const e = events.find((x) => x.type === 'tool_result' && 'callId' in x && x.callId === callId)
    return e && 'output' in e ? String(e.output) : ''
  }
  /** Whether some executed sandbox command contains `text` (session preludes may wrap it). */
  const ran = (text: string): boolean => h.calls.some((c) => c.command.includes(text))

  it('a managed-policy ask rule still prompts after "Allow for run" on an unconfined shell', async () => {
    h.sandboxed = false
    h.managedRules = [{ action: 'ask', tool: 'run_shell', match: 'rm *' }]
    let prompted = 0
    const { events } = await run({
      turns: shellTurns('echo hi', 'rm -rf build'),
      // First prompt is the plain unconfined-shell one — grant the per-run consent.
      // The second (the managed ask) must still fire; deny it to prove it is binding.
      onApproval: (_id, decide) => decide(prompted++ === 0 ? 'always' : 'deny')
    })
    const p = prompts(events)
    expect(p).toHaveLength(2)
    // Both prompts carry the unconfined banner — the ask rule doesn't hide that the
    // command would run unsandboxed.
    expect(p[0]).toMatchObject({ callId: 's1', sandboxed: false })
    expect(p[1]).toMatchObject({ callId: 's2', sandboxed: false })
    expect(resultFor(events, 's2')).toContain('Denied by the user')
    expect(ran('echo hi')).toBe(true)
    expect(ran('rm -rf build')).toBe(false)
  })

  it("a user-tier ask rule also survives — per-run consent is not the user's hook", async () => {
    // Unlike a hook approve (which may skip the user's OWN ask rule — see above), the
    // per-run unconfined-shell consent says nothing about the rule's subject: a user
    // rule written to always prompt keeps prompting, as it does under a generic
    // override on a confining host.
    h.sandboxed = false
    h.settings.permissionRules = [{ action: 'ask', tool: 'run_shell', match: 'rm *' }]
    let prompted = 0
    const { events } = await run({
      turns: shellTurns('echo hi', 'rm -rf build'),
      // Approve the second prompt: the forced prompt is real, not a dead end.
      onApproval: (_id, decide) => decide(prompted++ === 0 ? 'always' : 'allow')
    })
    expect(prompts(events)).toHaveLength(2)
    expect(ran('rm -rf build')).toBe(true)
  })

  it('without an ask rule the consent still auto-approves later commands (no over-tightening)', async () => {
    h.sandboxed = false
    const { events } = await run({
      turns: shellTurns('echo hi', 'echo bye'),
      onApproval: (_id, decide) => decide('always')
    })
    expect(prompts(events)).toHaveLength(1)
    expect(ran('echo hi')).toBe(true)
    expect(ran('echo bye')).toBe(true)
  })
})
