import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AgentEvent,
  ChatMessage,
  PlanDecision,
  PlanPayload,
  Provider,
  ProviderStreamEvent,
  ToolApprovalDecision
} from '@shared/agent'
import type { ApprovalPolicy } from '@shared/types'
import type { ToolDef } from './tools'
import { INTERRUPTED_TOOL_RESULT, missingToolResults } from './repair'

// Hoisted holders the mocks read, so each test can swap the fake provider/settings.
const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  mcpDefs: [] as ToolDef[],
  // Rules captured from the addPermissionRule mock, so tests can assert what an
  // "Always allow/deny" decision persisted.
  addedRules: [] as unknown[],
  settings: {
    compactionThreshold: 0,
    reasoningEffort: 'off',
    permissionRules: [],
    hooks: [],
    mcpServers: [],
    additionalRoots: [],
    // Opted in so the lifecycle-hook assertions exercise the recording host; the
    // default-off gate is asserted separately below.
    projectPlugins: true
  } as Record<string, unknown>,
  // Records every plugin lifecycle event the loop fires, for assertions.
  pluginEvents: [] as Array<{ event: string; payload: unknown }>,
  // Known secret values the tool-result redactor should strip; set per test.
  secrets: [] as string[]
}))

vi.mock('../agentHost', () => ({
  getSettings: () => h.settings,
  addPermissionRule: (rule: unknown) => {
    h.addedRules.push(rule)
  },
  getProvider: () => ({
    id: 'anthropic',
    kind: 'anthropic',
    label: 'A',
    models: [],
    requiresKey: false,
    hasKey: true,
    builtIn: true
  }),
  getKey: () => null,
  collectSecrets: () => h.secrets
}))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => h.mcpDefs }))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))
// Stub the plugin loader with a host that records every event the loop fires, so
// we can assert the lifecycle hooks (onUserMessage/onToolStart/onToolResult) fire
// at the right points. The real loader/host is covered in plugins.test.ts. The
// gate mirrors production: a host only loads when `enabled === true`, otherwise an
// inert empty host (so the loop's gating is exercised end-to-end).
vi.mock('./plugins', () => {
  const recordingHost = {
    has: () => true,
    get size() {
      return 1
    },
    emit: async (event: string, payload: unknown) => {
      h.pluginEvents.push({ event, payload })
    }
  }
  const emptyHost = { has: () => false, size: 0, emit: async () => {} }
  return {
    loadPlugins: async () => recordingHost,
    loadPluginsIfEnabled: async (_ws: string, enabled: boolean | undefined) =>
      enabled === true ? recordingHost : emptyHost
  }
})

// Imported after the mocks are registered.
const {
  startRun,
  cancelRun,
  resolveApproval,
  resolveQuestion,
  resolvePlan,
  setRunPolicy,
  activeRunForConversation,
  pendingPromptsForConversation,
  activeRunCount,
  runningConversationIds,
  onActiveRunsChanged
} = await import('./loop')

/** A provider that replays one pre-scripted turn per streamChat call. */
function scripted(turns: ProviderStreamEvent[][]): Provider {
  let i = 0
  return {
    async *streamChat() {
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]
      for (const ev of turn) yield ev
    }
  }
}

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-loop-'))
  h.pluginEvents = []
  h.addedRules = []
  h.secrets = []
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  h.mcpDefs = []
  vi.restoreAllMocks()
})

interface RunResult {
  events: AgentEvent[]
  messages: ChatMessage[]
}

/** Run a turn to completion. `onApproval` lets a test resolve approval prompts. */
async function run(
  opts: {
    turns?: ProviderStreamEvent[][]
    provider?: Provider
    messages?: ChatMessage[]
    policy?: ApprovalPolicy
    userText?: string
    onApproval?: (callId: string, decide: (d: ToolApprovalDecision) => void) => void
    onQuestion?: (callId: string, answer: (a: string) => void) => void
    onPlan?: (callId: string, plan: PlanPayload, decide: (d: PlanDecision) => void) => void
    conversationId?: string
  }
): Promise<RunResult> {
  h.provider = opts.provider ?? scripted(opts.turns ?? [])
  const runId = `run-${Math.round(Math.random() * 1e9)}`
  const events: AgentEvent[] = []
  let messages: ChatMessage[] = []
  const send = (e: AgentEvent): void => {
    events.push(e)
    if (e.type === 'tool_approval' && opts.onApproval) {
      // Respond on a later tick — the loop registers the approval resolver on the
      // line *after* it emits tool_approval, just as the real renderer replies async.
      setTimeout(() => opts.onApproval!(e.callId, (d) => resolveApproval(runId, e.callId, d)), 0)
    }
    if (e.type === 'tool_question' && opts.onQuestion) {
      setTimeout(() => opts.onQuestion!(e.callId, (a) => resolveQuestion(runId, e.callId, a)), 0)
    }
    if (e.type === 'plan_ready' && opts.onPlan) {
      setTimeout(() => opts.onPlan!(e.callId, e.plan, (d) => resolvePlan(runId, e.callId, d)), 0)
    }
  }
  await startRun(
    {
      runId,
      ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
      workspace: ws,
      providerId: 'anthropic',
      model: 'claude-test',
      approvalPolicy: opts.policy ?? 'ask',
      messages: opts.messages ?? [{ role: 'user', content: opts.userText ?? 'do it' }]
    },
    send,
    (m) => {
      messages = m
    }
  )
  return { events, messages }
}

const types = (r: RunResult): string[] => r.events.map((e) => e.type)

/**
 * Ids of any `tool_use` whose `tool_result` is not in the contiguous tool block
 * immediately after its assistant turn — i.e. what the Anthropic API rejects.
 */
function orphanedToolUses(ms: ChatMessage[]): string[] {
  const bad: string[] = []
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]
    if (m.role !== 'assistant' || !(m.toolCalls?.length ?? 0)) continue
    const answered = new Set<string>()
    let j = i + 1
    while (j < ms.length && ms[j].role === 'tool') {
      if (ms[j].toolCallId) answered.add(ms[j].toolCallId as string)
      j++
    }
    for (const c of m.toolCalls ?? []) if (!answered.has(c.id)) bad.push(c.id)
  }
  return bad
}

describe('startRun', () => {
  it('streams a plain answer and persists the assistant message', async () => {
    const r = await run({
      turns: [[{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }, { type: 'done', stopReason: 'end_turn' }]]
    })
    expect(types(r)).toContain('text')
    expect(types(r).at(-1)).toBe('done')
    const assistant = r.messages.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('hello world')
  })

  it('estimates context size when the provider reports no token usage', async () => {
    // The scripted provider's `done` carries no usage; the loop should fall back to
    // an estimate so the context-size readout never sits at zero (local models, etc.).
    const r = await run({
      turns: [[{ type: 'text', text: 'hi' }, { type: 'done', stopReason: 'end_turn' }]]
    })
    const usage = r.events.find((e) => e.type === 'usage') as { inputTokens: number } | undefined
    expect(usage).toBeTruthy()
    expect(usage!.inputTokens).toBeGreaterThan(0)
  })

  it('runs a read tool then finishes (reads from the workspace)', async () => {
    writeFileSync(join(ws, 'note.txt'), 'the secret')
    const r = await run({
      policy: 'full-auto',
      turns: [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done reading' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })
    const result = r.events.find((e) => e.type === 'tool_result')
    expect(result).toMatchObject({ name: 'read_file', ok: true })
    expect((result as { output: string }).output).toContain('the secret')
  })

  it('redacts stored secrets from a tool result before the model, UI, and transcript see it', async () => {
    h.secrets = ['stored-opaque-credential-value-xyz']
    // A file the agent reads that happens to contain this install's own credential (an
    // opaque value with no recognizable token format) plus a token-shaped third-party
    // secret we hold no stored copy of — exercising both redaction layers.
    writeFileSync(
      join(ws, 'config.env'),
      'KEY=stored-opaque-credential-value-xyz\nGH=ghp_' + 'A'.repeat(36)
    )
    const r = await run({
      policy: 'full-auto',
      turns: [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'config.env' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'read it' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })
    const emitted = r.events.find((e) => e.type === 'tool_result') as { output: string }
    // Known-value redaction strips the stored key; pattern redaction strips the GitHub token.
    expect(emitted.output).not.toContain('stored-opaque-credential-value-xyz')
    expect(emitted.output).toContain('[redacted:secret]')
    expect(emitted.output).toContain('[redacted:github-token]')
    // The redacted text — not the plaintext — is what was persisted to the transcript
    // and fed back to the model as the tool message.
    const toolMsg = r.messages.find((m) => m.role === 'tool')
    expect(String(toolMsg?.content)).not.toContain('stored-opaque-credential-value-xyz')
    expect(String(toolMsg?.content)).toContain('[redacted:secret]')
    // The onToolResult plugin event also saw the scrubbed output.
    const pluginResult = h.pluginEvents.find((e) => e.event === 'onToolResult')?.payload as {
      output: string
    }
    expect(pluginResult.output).not.toContain('stored-opaque-credential-value-xyz')
  })

  it('redacts secrets from the user turn before the model and transcript see it', async () => {
    h.secrets = ['stored-opaque-credential-value-xyz']
    const r = await run({
      userText: 'my key is stored-opaque-credential-value-xyz and ghp_' + 'A'.repeat(36),
      turns: [[{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]]
    })
    const userMsg = r.messages.find((m) => m.role === 'user')
    expect(String(userMsg?.content)).not.toContain('stored-opaque-credential-value-xyz')
    expect(String(userMsg?.content)).toContain('[redacted:secret]') // known-value layer
    expect(String(userMsg?.content)).toContain('[redacted:github-token]') // pattern layer
  })

  it('leaves ordinary composer prose in the user turn untouched', async () => {
    const r = await run({
      userText: 'my password is blah',
      turns: [[{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]]
    })
    const userMsg = r.messages.find((m) => m.role === 'user')
    expect(String(userMsg?.content)).toBe('my password is blah')
  })

  it('prompts for a write under "ask" and writes the file when allowed', async () => {
    const r = await run({
      policy: 'ask',
      onApproval: (_id, decide) => decide('allow'),
      turns: [
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'wrote it' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })
    expect(types(r)).toContain('tool_approval')
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('hi')
  })

  it('does not write when the user denies', async () => {
    const r = await run({
      policy: 'ask',
      onApproval: (_id, decide) => decide('deny'),
      turns: [
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'nope.txt', content: 'x' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ]
    })
    expect(existsSync(join(ws, 'nope.txt'))).toBe(false)
    const result = r.events.find((e) => e.type === 'tool_result')
    expect((result as { output: string }).output).toMatch(/Denied/)
  })

  it('blocks writes in plan mode', async () => {
    const r = await run({
      policy: 'plan',
      turns: [
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'p.txt', content: 'x' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ]
    })
    expect(existsSync(join(ws, 'p.txt'))).toBe(false)
    const result = r.events.find((e) => e.type === 'tool_result')
    expect((result as { output: string }).output).toMatch(/Plan mode/)
  })

  it('blocks a mutating GitHub tool (gh_pr_create) in plan mode without prompting', async () => {
    const r = await run({
      policy: 'plan',
      turns: [
        [
          { type: 'tool_call', call: { id: 'g1', name: 'gh_pr_create', arguments: { title: 'x' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ]
    })
    // blockedInPlan short-circuits before approval — no network prompt, no run.
    expect(types(r)).not.toContain('tool_approval')
    const result = r.events.find((e) => e.type === 'tool_result')
    expect((result as { output: string }).output).toMatch(/Plan mode/)
  })

  it('runs an all-reads turn concurrently and returns results for each call', async () => {
    writeFileSync(join(ws, 'a.txt'), 'AAA')
    writeFileSync(join(ws, 'b.txt'), 'BBB')
    const r = await run({
      policy: 'full-auto',
      turns: [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } } },
          { type: 'tool_call', call: { id: 'c2', name: 'read_file', arguments: { path: 'b.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'read both' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })
    const results = r.events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(2)
    const outputs = results.map((e) => (e as { output: string }).output).join('\n')
    expect(outputs).toContain('AAA')
    expect(outputs).toContain('BBB')
  })

  it('runs the LEADING read subset of a MIXED turn concurrently, with the trailing write sequential/approved, results in original order', async () => {
    // A barrier that only releases once BOTH leading reads have entered execute —
    // if the reads ran sequentially, the second would never start before the first
    // resolved and this would deadlock (test times out). The reads LEAD the turn
    // (nothing encumbered precedes them), so they are the parallel group.
    let arrived = 0
    let release!: () => void
    const barrier = new Promise<void>((r) => (release = r))
    const reach = async (): Promise<void> => {
      if (++arrived === 2) release()
      await barrier
    }
    // Two read-kind tools (parallelizable) registered as MCP defs so we control
    // their execution, plus the real write_file (sequential + approval).
    const readA: ToolDef = {
      kind: 'read',
      summarize: () => 'read A',
      schema: { name: 'read_a', description: 'read A', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        await reach()
        return 'RESULT_A'
      }
    }
    const readB: ToolDef = {
      kind: 'read',
      summarize: () => 'read B',
      schema: { name: 'read_b', description: 'read B', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        await reach()
        return 'RESULT_B'
      }
    }
    h.mcpDefs = [readA, readB]

    const approvals: string[] = []
    const r = await run({
      policy: 'ask',
      onApproval: (callId, decide) => {
        approvals.push(callId)
        decide('allow')
      },
      turns: [
        [
          // Original order: read_a, read_b, write — the two reads LEAD, the write
          // trails. The leading reads parallelize; the write runs after.
          { type: 'tool_call', call: { id: 'ra', name: 'read_a', arguments: {} } },
          { type: 'tool_call', call: { id: 'rb', name: 'read_b', arguments: {} } },
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'W' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })

    // Only the write prompted for approval — the reads never do.
    expect(approvals).toEqual(['w1'])
    // The write actually ran (sequential path, approved).
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('W')

    // Every tool_result is present and in the ORIGINAL call order (ra, rb, w1),
    // both in the emitted events and in the persisted message log.
    const resultOrder = r.events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as { callId: string }).callId)
    expect(resultOrder).toEqual(['ra', 'rb', 'w1'])

    const toolMsgs = r.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['ra', 'rb', 'w1'])
    // The two read results keep their exact content and their original positions,
    // even though they resolved concurrently.
    expect(toolMsgs[0].content).toBe('RESULT_A')
    expect(toolMsgs[1].content).toBe('RESULT_B')
  }, 20_000)

  it('rejects a tool call with invalid arguments before dispatch and returns a repair message', async () => {
    // read_file requires `path`; sending a number where a string belongs must be
    // repaired (not executed) so the model self-corrects — and the file the model
    // was "reading" is never touched.
    let executed = false
    const badRead: ToolDef = {
      kind: 'read',
      summarize: () => 'bad read',
      schema: {
        name: 'strict_read',
        description: 'requires a string path',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false
        }
      },
      execute: async () => {
        executed = true
        return 'SHOULD NOT RUN'
      }
    }
    h.mcpDefs = [badRead]

    const r = await run({
      policy: 'full-auto',
      turns: [
        [
          { type: 'tool_call', call: { id: 'b1', name: 'strict_read', arguments: { path: 123 } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'noted' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })

    expect(executed).toBe(false)
    const result = r.events.find((e) => e.type === 'tool_result' && e.name === 'strict_read') as
      | { ok: boolean; output: string }
      | undefined
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain('Invalid arguments')
    expect(result?.output).toContain('path')
    // A repaired call still gets a matching tool message (log stays provider-valid).
    expect(r.messages.filter((m) => m.role === 'tool' && m.toolCallId === 'b1')).toHaveLength(1)
  })

  it('rejects invalid args for a write BEFORE prompting for approval', async () => {
    // write_file needs path + content; omit content. The call must be repaired
    // without ever prompting the user to approve an unrunnable write.
    const r = await run({
      policy: 'ask',
      onApproval: (_id, decide) => decide('allow'),
      turns: [
        [
          { type: 'tool_call', call: { id: 'bw', name: 'write_file', arguments: { path: 'x.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'noted' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })
    expect(types(r)).not.toContain('tool_approval')
    expect(existsSync(join(ws, 'x.txt'))).toBe(false)
    const result = r.events.find((e) => e.type === 'tool_result' && e.name === 'write_file') as
      | { ok: boolean; output: string }
      | undefined
    expect(result?.ok).toBe(false)
    expect(result?.output).toContain('Invalid arguments')
    expect(result?.output).toContain('content')
  })

  it('preserves intra-turn read-after-write: a read after a write in the same turn observes the WRITTEN content', async () => {
    // [write_file X, read_file X] in one turn. Because the read follows the write,
    // it must run sequentially AFTER the write (not race ahead in the parallel
    // group), so it observes the just-written content rather than a stale/absent
    // file. Regression guard for the read-after-write ordering fix.
    const r = await run({
      policy: 'full-auto',
      turns: [
        [
          {
            type: 'tool_call',
            call: { id: 'w1', name: 'write_file', arguments: { path: 'note.txt', content: 'FRESH' } }
          },
          { type: 'tool_call', call: { id: 'r1', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })

    // The write ran, then the read saw its output.
    expect(readFileSync(join(ws, 'note.txt'), 'utf8')).toBe('FRESH')
    const readResult = r.events.find((e) => e.type === 'tool_result' && e.name === 'read_file') as
      | { ok: boolean; output: string }
      | undefined
    expect(readResult?.ok).toBe(true)
    expect(readResult?.output).toContain('FRESH')

    // Results are appended in original call order (write, then read).
    const toolMsgs = r.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['w1', 'r1'])
    expect(toolMsgs[1].content).toContain('FRESH')
  })

  it('runs a leading parallel read group where one read has invalid args: the valid read executes, the invalid one is repaired, both appear in original order', async () => {
    // Two leading reads (parallel group): the first has bad args (repaired without
    // a tool_start, never executed), the second is valid and runs. Both produce a
    // tool_result in original order, and the invalid one carries the repair message.
    let validExecuted = false
    const strictRead: ToolDef = {
      kind: 'read',
      summarize: () => 'strict read',
      schema: {
        name: 'strict_read',
        description: 'requires a string path',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false
        }
      },
      execute: async () => 'SHOULD NOT RUN'
    }
    const okRead: ToolDef = {
      kind: 'read',
      summarize: () => 'ok read',
      schema: { name: 'ok_read', description: 'ok read', parameters: { type: 'object', properties: {} } },
      execute: async () => {
        validExecuted = true
        return 'VALID_OUTPUT'
      }
    }
    h.mcpDefs = [strictRead, okRead]

    const r = await run({
      policy: 'full-auto',
      turns: [
        [
          // Both lead the turn, so both are in the parallel group.
          { type: 'tool_call', call: { id: 'bad', name: 'strict_read', arguments: { path: 123 } } },
          { type: 'tool_call', call: { id: 'good', name: 'ok_read', arguments: {} } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })

    // The valid read executed; the invalid one never did.
    expect(validExecuted).toBe(true)

    // No tool_start was emitted for the refused (invalid-args) call.
    const startedIds = r.events
      .filter((e) => e.type === 'tool_start')
      .map((e) => (e as { callId: string }).callId)
    expect(startedIds).toContain('good')
    expect(startedIds).not.toContain('bad')

    // Both results are present, in ORIGINAL call order (bad, good).
    const resultOrder = r.events
      .filter((e) => e.type === 'tool_result')
      .map((e) => (e as { callId: string }).callId)
    expect(resultOrder).toEqual(['bad', 'good'])

    const toolMsgs = r.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['bad', 'good'])
    expect(toolMsgs[0].content).toContain('Invalid arguments')
    expect(toolMsgs[1].content).toBe('VALID_OUTPUT')
  })

  it('retries a transient failure, then succeeds (nothing streamed yet)', async () => {
    const turns: ProviderStreamEvent[][] = [
      [{ type: 'error', message: 'Overloaded' }],
      [{ type: 'text', text: 'recovered' }, { type: 'done', stopReason: 'end_turn' }]
    ]
    const r = await run({ turns })
    expect(types(r)).toContain('retry')
    expect(types(r).at(-1)).toBe('done')
    expect(r.messages.find((m) => m.role === 'assistant')?.content).toBe('recovered')
  }, 20_000)

  it('surfaces a non-transient error without retrying', async () => {
    const r = await run({ turns: [[{ type: 'error', message: 'invalid api key' }]] })
    expect(types(r)).not.toContain('retry')
    expect(types(r).at(-1)).toBe('error')
  })

  it('replaces a "model does not support tools" error with actionable guidance', async () => {
    const r = await run({
      turns: [[{ type: 'error', message: 'registry.ollama.ai/library/llama2:latest does not support tools' }]]
    })
    expect(types(r)).not.toContain('retry')
    const last = r.events.at(-1)
    expect(last?.type).toBe('error')
    const msg = (last as { message: string }).message
    expect(msg).toContain("doesn't support tool calling")
    expect(msg).toContain('qwen2.5-coder')
    expect(msg).not.toContain('registry.ollama.ai') // the opaque raw string is replaced
  })

  it('recovers from a context-overflow error by force-compacting older turns', async () => {
    // Many older turns plus the current one. The first send overflows; the loop
    // should summarize older turns and retry the (now smaller) request.
    const history: ChatMessage[] = []
    for (let t = 0; t < 4; t++) {
      history.push({ role: 'user', content: `old question ${t}` })
      history.push({ role: 'assistant', content: `old answer ${t}` })
    }
    history.push({ role: 'user', content: 'current question' })

    let summarized = false
    const mainSends: ChatMessage[][] = []
    const provider: Provider = {
      async *streamChat(req) {
        // Summarization calls are the only ones that set maxTokens.
        if (req.maxTokens != null) {
          summarized = true
          yield { type: 'text', text: 'COMPACTED SUMMARY' }
          yield { type: 'done', stopReason: 'end_turn' }
          return
        }
        mainSends.push(req.messages)
        if (mainSends.length === 1) {
          yield { type: 'error', message: 'prompt is too long: 212129 tokens > 200000 maximum' }
          return
        }
        yield { type: 'text', text: 'recovered' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }

    const r = await run({ provider, messages: history })

    expect(types(r)).toContain('compaction')
    expect(types(r).at(-1)).toBe('done')
    expect(r.messages.find((m) => m.role === 'assistant' && m.content === 'recovered')).toBeTruthy()
    // A summarization happened, and the retried send led with the synthetic summary
    // (older turns folded away) where the first, overflowing send did not.
    expect(summarized).toBe(true)
    expect(mainSends).toHaveLength(2)
    // Durable context prepends a pinned working-memory block ahead of everything, so
    // the summary no longer sits at index 0 — assert on the window contents instead.
    const joined = (w: ChatMessage[]): string => w.map((m) => m.content).join('\n')
    expect(joined(mainSends[0])).not.toContain('COMPACTED SUMMARY')
    expect(joined(mainSends[1])).toContain('COMPACTED SUMMARY')
    // The pinned block rides both sends and carries the original task verbatim.
    expect(joined(mainSends[0])).toContain('Pinned working memory')
    expect(joined(mainSends[1])).toContain('Pinned working memory')
  })

  it('surfaces a clear error when even the latest turn overflows the window', async () => {
    // A single user turn — nothing older to compact away. The overflow can't be
    // recovered, so the run should fail with a friendly, actionable message.
    const provider: Provider = {
      async *streamChat() {
        yield { type: 'error', message: 'prompt is too long: 999999 tokens > 200000 maximum' }
      }
    }
    const r = await run({ provider, messages: [{ role: 'user', content: 'huge paste' }] })
    expect(types(r)).not.toContain('compaction')
    const last = r.events.at(-1)
    expect(last?.type).toBe('error')
    expect((last as { message: string }).message).toContain('context window')
  })

  it('applies a mid-run loosening (ask → full-auto) to later tool calls', async () => {
    // Two sequential single-write turns. Start under "ask"; when the first write
    // prompts, flip the live policy to full-auto before answering. The second
    // write must then auto-approve — no second prompt — and land on disk.
    h.provider = scripted([
      [
        { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'one.txt', content: 'a' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [
        { type: 'tool_call', call: { id: 'w2', name: 'write_file', arguments: { path: 'two.txt', content: 'b' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const runId = 'run-loosen'
    const events: AgentEvent[] = []
    const send = (e: AgentEvent): void => {
      events.push(e)
      if (e.type === 'tool_approval') {
        setTimeout(() => {
          setRunPolicy(runId, 'full-auto') // live switch, before resolving the prompt
          resolveApproval(runId, e.callId, 'allow')
        }, 0)
      }
    }
    await startRun(
      {
        runId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'do it' }]
      },
      send,
      () => {}
    )
    expect(events.filter((e) => e.type === 'tool_approval')).toHaveLength(1) // only w1 prompted
    expect(readFileSync(join(ws, 'one.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(ws, 'two.txt'), 'utf8')).toBe('b')
  })

  it('applies a mid-run tightening (full-auto → plan) to block later writes', async () => {
    // Start in full-auto so the first write runs without a prompt. On its result,
    // switch to plan — the second write in the next turn must be blocked outright.
    h.provider = scripted([
      [
        { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'one.txt', content: 'a' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [
        { type: 'tool_call', call: { id: 'w2', name: 'write_file', arguments: { path: 'two.txt', content: 'b' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const runId = 'run-tighten'
    const events: AgentEvent[] = []
    let flipped = false
    const send = (e: AgentEvent): void => {
      events.push(e)
      // Switch to plan synchronously after the first write completes (between turns).
      if (e.type === 'tool_result' && e.name === 'write_file' && !flipped) {
        flipped = true
        setRunPolicy(runId, 'plan')
      }
    }
    await startRun(
      {
        runId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'full-auto',
        messages: [{ role: 'user', content: 'do it' }]
      },
      send,
      () => {}
    )
    expect(readFileSync(join(ws, 'one.txt'), 'utf8')).toBe('a') // first write landed
    expect(existsSync(join(ws, 'two.txt'))).toBe(false) // second blocked by plan
    const blocked = events.find(
      (e) => e.type === 'tool_result' && e.name === 'write_file' && !e.ok
    )
    expect((blocked as { output: string }).output).toMatch(/Plan mode/)
  })

  it('"Allow for run" is per-kind: a write grant does not auto-approve shell', async () => {
    const approvals: string[] = []
    const r = await run({
      policy: 'ask',
      turns: [
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'one.txt', content: 'a' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'tool_call', call: { id: 'w2', name: 'write_file', arguments: { path: 'two.txt', content: 'b' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'tool_call', call: { id: 's1', name: 'run_shell', arguments: { command: 'echo hi' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onApproval: (callId, decide) => {
        approvals.push(callId)
        decide(callId === 'w1' ? 'always' : 'deny') // grant writes for the run; reject the shell
      }
    })
    // w1 prompted (granted), w2 auto-approved by the write grant, s1 still prompted —
    // the grant did not leak across kinds.
    expect(approvals).toEqual(['w1', 's1'])
    expect(readFileSync(join(ws, 'two.txt'), 'utf8')).toBe('b')
    expect((r.events.filter((e) => e.type === 'tool_approval') as Array<{ callId: string }>).map((e) => e.callId)).toEqual([
      'w1',
      's1'
    ])
  })

  it('"Always deny" persists a rule and denies the current and future calls', async () => {
    const r = await run({
      policy: 'ask',
      turns: [
        [
          { type: 'tool_call', call: { id: 'd1', name: 'write_file', arguments: { path: 'secret.txt', content: 'x' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'tool_call', call: { id: 'd2', name: 'write_file', arguments: { path: 'secret.txt', content: 'y' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onApproval: (_callId, decide) => decide('rule-deny')
    })
    expect(h.addedRules).toContainEqual({ action: 'deny', tool: 'write_file', match: 'secret.txt' })
    // Only d1 prompted; d2 was auto-denied by the freshly-added rule.
    expect((r.events.filter((e) => e.type === 'tool_approval') as Array<{ callId: string }>).map((e) => e.callId)).toEqual([
      'd1'
    ])
    expect(existsSync(join(ws, 'secret.txt'))).toBe(false)
    expect(r.events.filter((e) => e.type === 'tool_result' && !e.ok)).toHaveLength(2)
  })

  it('"Always allow" persists a rule and auto-approves the current and future calls', async () => {
    const r = await run({
      policy: 'ask',
      turns: [
        [
          { type: 'tool_call', call: { id: 'a1', name: 'write_file', arguments: { path: 'notes.txt', content: 'one' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'tool_call', call: { id: 'a2', name: 'write_file', arguments: { path: 'notes.txt', content: 'two' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onApproval: (_callId, decide) => decide('rule-allow')
    })
    expect(h.addedRules).toContainEqual({ action: 'allow', tool: 'write_file', match: 'notes.txt' })
    // Only a1 prompted; a2 auto-approved by the rule, and both writes ran.
    expect((r.events.filter((e) => e.type === 'tool_approval') as Array<{ callId: string }>).map((e) => e.callId)).toEqual([
      'a1'
    ])
    expect(readFileSync(join(ws, 'notes.txt'), 'utf8')).toBe('two')
  })

  it('rejects an unknown mid-run policy (fails closed, keeps prompting)', async () => {
    // An off-list value must be ignored — the policy stays 'ask', so the second
    // write still prompts rather than silently fading open to auto-approve.
    h.provider = scripted([
      [
        { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'one.txt', content: 'a' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [
        { type: 'tool_call', call: { id: 'w2', name: 'write_file', arguments: { path: 'two.txt', content: 'b' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
    ])
    const runId = 'run-bogus'
    const events: AgentEvent[] = []
    const send = (e: AgentEvent): void => {
      events.push(e)
      if (e.type === 'tool_approval') {
        setTimeout(() => {
          setRunPolicy(runId, 'nonsense' as unknown as ApprovalPolicy)
          resolveApproval(runId, e.callId, 'allow')
        }, 0)
      }
    }
    await startRun(
      {
        runId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'do it' }]
      },
      send,
      () => {}
    )
    expect(events.filter((e) => e.type === 'tool_approval')).toHaveLength(2) // both still prompted
    expect(readFileSync(join(ws, 'one.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(ws, 'two.txt'), 'utf8')).toBe('b')
  })

  it('re-reads the reasoning effort each model turn (mid-run thinking change goes live)', async () => {
    // The provider records the effort it is sent per turn. After the first turn it
    // swaps the settings object — as saveSettings does when the dropdown changes —
    // to a higher effort. The second turn must be sent the new value, proving the
    // reasoning level is read live each turn rather than snapshotted at run start.
    // (We reassign h.settings rather than mutate a field so a snapshot-reading loop
    // would keep the old object and fail — the mock returns h.settings by reference.)
    writeFileSync(join(ws, 'x.txt'), 'hi')
    const original = h.settings
    try {
      h.settings = { ...h.settings, reasoningEffort: 'low' }
      const seen: unknown[] = []
      const provider: Provider = {
        async *streamChat(req) {
          seen.push(req.reasoningEffort)
          if (seen.length === 1) {
            h.settings = { ...h.settings, reasoningEffort: 'high' } // user bumps thinking mid-run
            yield { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'x.txt' } } }
            yield { type: 'done', stopReason: 'tool_use' }
            return
          }
          yield { type: 'text', text: 'done' }
          yield { type: 'done', stopReason: 'end_turn' }
        }
      }
      await run({ provider })
      expect(seen).toEqual(['low', 'high'])
    } finally {
      h.settings = original
    }
  })
})

describe('one run per conversation', () => {
  it('rejects a second run while one is already in flight on the same conversation', async () => {
    // Run A's first turn blocks on a gate we control, so it stays active while we
    // attempt run B on the same conversation. Without the guard, both would call
    // onMessages and interleave their writes to the conversation's message log.
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.provider = {
      async *streamChat() {
        await gate
        yield { type: 'text', text: 'A finished' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }

    const conversationId = 'conv-guard'
    const eventsA: AgentEvent[] = []
    // startRun runs synchronously up to its first await, so by the time this call
    // returns its promise the conversation is already registered as active.
    const startA = startRun(
      {
        runId: 'run-A',
        conversationId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'go' }]
      },
      (e) => eventsA.push(e),
      () => {}
    )
    expect(activeRunForConversation(conversationId)).toBe('run-A')

    // Run B targets the same conversation — it must be refused, not run.
    const eventsB: AgentEvent[] = []
    let bWroteMessages = false
    await startRun(
      {
        runId: 'run-B',
        conversationId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'again' }]
      },
      (e) => eventsB.push(e),
      () => {
        bWroteMessages = true
      }
    )

    // B emitted a single error addressed to itself and never touched the log.
    expect(eventsB).toHaveLength(1)
    expect(eventsB[0]).toMatchObject({ runId: 'run-B', type: 'error' })
    expect(bWroteMessages).toBe(false)
    // A is still the live run for the conversation.
    expect(activeRunForConversation(conversationId)).toBe('run-A')

    // Let A finish and confirm the conversation's slot is freed afterwards.
    release()
    await startA
    expect(eventsA.at(-1)).toMatchObject({ type: 'done' })
    expect(activeRunForConversation(conversationId)).toBeNull()
  })

  it('frees the conversation slot after a run ends so the next run can start', async () => {
    const conversationId = 'conv-sequential'
    h.provider = scripted([[{ type: 'text', text: 'first' }, { type: 'done', stopReason: 'end_turn' }]])
    await startRun(
      {
        runId: 'run-1',
        conversationId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'one' }]
      },
      () => {},
      () => {}
    )
    expect(activeRunForConversation(conversationId)).toBeNull()

    // A fresh run on the same conversation now succeeds (no stale lock).
    h.provider = scripted([[{ type: 'text', text: 'second' }, { type: 'done', stopReason: 'end_turn' }]])
    const events: AgentEvent[] = []
    await startRun(
      {
        runId: 'run-2',
        conversationId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'two' }]
      },
      (e) => events.push(e),
      () => {}
    )
    expect(events.some((e) => e.type === 'text')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('counts live runs across conversations and clears them as they finish', async () => {
    // Two conversations, each gated open, so we can watch the live count rise and
    // fall as runs start and complete. This count is what the quit guard reads.
    expect(activeRunCount()).toBe(0)

    const gates: Array<() => void> = []
    const gated = (): Provider => {
      let release!: () => void
      gates.push(() => release())
      const gate = new Promise<void>((r) => {
        release = r
      })
      return {
        async *streamChat() {
          await gate
          yield { type: 'done', stopReason: 'end_turn' }
        }
      }
    }

    h.provider = gated()
    const startA = startRun(
      {
        runId: 'count-A',
        conversationId: 'conv-count-A',
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'a' }]
      },
      () => {},
      () => {}
    )
    expect(activeRunCount()).toBe(1)

    h.provider = gated()
    const startB = startRun(
      {
        runId: 'count-B',
        conversationId: 'conv-count-B',
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'b' }]
      },
      () => {},
      () => {}
    )
    expect(activeRunCount()).toBe(2)

    gates[0]()
    await startA
    expect(activeRunCount()).toBe(1)

    gates[1]()
    await startB
    expect(activeRunCount()).toBe(0)
  })

  it('reports running conversation ids and notifies listeners as runs start/end', async () => {
    expect(runningConversationIds()).toEqual([])
    const sets: string[][] = []
    const off = onActiveRunsChanged((ids) => sets.push(ids))

    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    h.provider = {
      async *streamChat() {
        await gate
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const run = startRun(
      {
        runId: 'ids-A',
        conversationId: 'conv-ids-A',
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'a' }]
      },
      () => {},
      () => {}
    )
    // Start fires a change with the conversation present.
    expect(runningConversationIds()).toEqual(['conv-ids-A'])
    expect(sets.at(-1)).toEqual(['conv-ids-A'])

    release()
    await run
    // End fires a change back to empty, and unsubscribing stops further calls.
    expect(runningConversationIds()).toEqual([])
    expect(sets.at(-1)).toEqual([])
    off()
  })
})

describe('lazy MCP tool loading', () => {
  const mcpDef = (i: number): ToolDef => ({
    kind: 'mcp',
    summarize: () => `srv:tool${i}`,
    schema: {
      name: `srv:tool${i}`,
      description: `MCP tool number ${i}.`,
      parameters: { type: 'object', properties: {} }
    },
    execute: () => Promise.resolve(`ran tool${i}`)
  })

  /** A provider that records the tool names offered on each request. */
  function recorder(turns: ProviderStreamEvent[][]): { provider: Provider; seen: string[][] } {
    const seen: string[][] = []
    let i = 0
    const provider: Provider = {
      async *streamChat(req) {
        seen.push((req.tools ?? []).map((t) => t.name))
        const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]
        for (const ev of turn) yield ev
      }
    }
    return { provider, seen }
  }

  it('defers MCP schemas above the threshold and reveals them via find_tools', async () => {
    // 20 connected MCP tools (> MCP_LAZY_THRESHOLD) — dumping all of them on every
    // request is exactly the context bloat we avoid.
    h.mcpDefs = Array.from({ length: 20 }, (_, i) => mcpDef(i))
    const { provider, seen } = recorder([
      [
        { type: 'tool_call', call: { id: 'c1', name: 'find_tools', arguments: { query: 'tool3' } } },
        { type: 'done', stopReason: 'tool_use' }
      ],
      [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
    ])

    await run({ provider })

    // First request: no MCP tool schemas, but the find_tools meta-tool is offered.
    expect(seen[0]).toContain('find_tools')
    expect(seen[0].some((n) => n.startsWith('srv:tool'))).toBe(false)
    // Second request: the tool revealed by find_tools now rides along; the other
    // 19 stay deferred.
    expect(seen[1]).toContain('srv:tool3')
    expect(seen[1]).not.toContain('srv:tool0')
  })

  it('sends every MCP schema as-is at or below the threshold', async () => {
    h.mcpDefs = Array.from({ length: 3 }, (_, i) => mcpDef(i))
    const { provider, seen } = recorder([[{ type: 'done', stopReason: 'end_turn' }]])
    await run({ provider })
    expect(seen[0]).toContain('srv:tool0')
    expect(seen[0]).toContain('srv:tool2')
    expect(seen[0]).not.toContain('find_tools')
  })
})

describe('ask_user', () => {
  it('emits a question, waits for the answer, and feeds it back to the model', async () => {
    const r = await run({
      turns: [
        [
          {
            type: 'tool_call',
            call: {
              id: 'q1',
              name: 'ask_user',
              arguments: { question: 'Which database?', options: ['SQLite', 'Postgres'] }
            }
          },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'Using Postgres.' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onQuestion: (_callId, answer) => answer('Postgres')
    })

    const q = r.events.find((e) => e.type === 'tool_question') as
      | { question: string; options: { label: string }[] }
      | undefined
    expect(q?.question).toBe('Which database?')
    expect(q?.options).toEqual([{ label: 'SQLite' }, { label: 'Postgres' }])
    // The answer comes back as the ask_user tool result and is persisted for the model.
    const result = r.events.find((e) => e.type === 'tool_result' && e.name === 'ask_user') as
      | { output: string }
      | undefined
    expect(result?.output).toBe('Postgres')
    const toolMsg = r.messages.find((m) => m.role === 'tool' && m.toolName === 'ask_user')
    expect(toolMsg?.content).toBe('Postgres')
    expect(types(r).at(-1)).toBe('done')
  })

  it('unblocks a pending question when the run is cancelled', async () => {
    // Drive startRun directly so the runId is in scope to cancel: with no answer,
    // the question must still resolve (via cancelRun) instead of hanging forever.
    h.provider = scripted([
      [
        { type: 'tool_call', call: { id: 'q1', name: 'ask_user', arguments: { question: 'Wait?' } } },
        { type: 'done', stopReason: 'tool_use' }
      ]
    ])
    const runId = 'run-cancel-question'
    const events: AgentEvent[] = []
    const send = (e: AgentEvent): void => {
      events.push(e)
      if (e.type === 'tool_question') setTimeout(() => cancelRun(runId), 0)
    }
    await startRun(
      {
        runId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'ask',
        messages: [{ role: 'user', content: 'go' }]
      },
      send
    )
    const result = events.find((e) => e.type === 'tool_result' && e.name === 'ask_user') as
      | { output: string }
      | undefined
    expect(result?.output).toContain('stopped the agent')
  })

  it('fires plugin lifecycle hooks: onUserMessage, then onToolStart/onToolResult around a tool', async () => {
    writeFileSync(join(ws, 'note.txt'), 'hi')
    await run({
      policy: 'full-auto',
      userText: 'read the note',
      turns: [
        [
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ]
    })
    const events = h.pluginEvents.map((e) => e.event)
    // onUserMessage fires first (before any model turn), then the tool's lifecycle.
    expect(events[0]).toBe('onUserMessage')
    expect(events).toContain('onToolStart')
    expect(events).toContain('onToolResult')
    expect(events.indexOf('onToolStart')).toBeLessThan(events.indexOf('onToolResult'))

    const userMsg = h.pluginEvents.find((e) => e.event === 'onUserMessage')
    expect(userMsg?.payload).toEqual({ text: 'read the note' })
    const start = h.pluginEvents.find((e) => e.event === 'onToolStart')
    expect(start?.payload).toMatchObject({ tool: 'read_file', input: { path: 'note.txt' } })
    const toolResult = h.pluginEvents.find((e) => e.event === 'onToolResult')
    expect(toolResult?.payload).toMatchObject({ tool: 'read_file', ok: true })
  })

  it('does not run workspace plugins when projectPlugins is off (default)', async () => {
    h.settings.projectPlugins = false
    try {
      await run({
        policy: 'full-auto',
        userText: 'read the note',
        turns: [
          [
            { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'note.txt' } } },
            { type: 'done', stopReason: 'tool_use' }
          ],
          [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
        ]
      })
      // The inert host fires nothing — opening a repo never runs its plugins.
      expect(h.pluginEvents).toHaveLength(0)
    } finally {
      h.settings.projectPlugins = true
    }
  })

  describe('interrupted-turn recovery', () => {
    it('backfills a placeholder for a dangling tool call left by a prior interrupted run', async () => {
      // History ends with an assistant tool_use and no matching result — the shape a
      // turn killed while parked on an approval prompt leaves behind. The run must
      // repair it (so the provider isn't sent invalid history) and finish normally.
      const r = await run({
        messages: [
          { role: 'user', content: 'compare the apps' },
          {
            role: 'assistant',
            content: 'fetching',
            toolCalls: [{ id: 'orphan1', name: 'web_fetch', arguments: { url: 'https://example.com' } }]
          }
        ],
        turns: [[{ type: 'text', text: 'continuing' }, { type: 'done', stopReason: 'end_turn' }]]
      })

      expect(types(r).at(-1)).toBe('done')
      // The dangling call now has a placeholder result, so nothing is left orphaned.
      expect(missingToolResults(r.messages)).toEqual([])
      const placeholder = r.messages.find((m) => m.role === 'tool' && m.toolCallId === 'orphan1')
      expect(placeholder?.content).toBe(INTERRUPTED_TOOL_RESULT)
    })

    it('backfills calls left unanswered when a multi-call turn is cancelled mid-sequence', async () => {
      // Two writes in one turn (sequential under "ask"): cancel on the first prompt.
      // The first becomes "Denied", the second never runs — the finally must pair it
      // so the persisted log has no dangling tool_use.
      h.provider = scripted([
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'a.txt', content: 'x' } } },
          { type: 'tool_call', call: { id: 'w2', name: 'write_file', arguments: { path: 'b.txt', content: 'y' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ])
      const runId = 'run-cancel-multicall'
      let messages: ChatMessage[] = []
      const send = (e: AgentEvent): void => {
        if (e.type === 'tool_approval') setTimeout(() => cancelRun(runId), 0)
      }
      await startRun(
        {
          runId,
          workspace: ws,
          providerId: 'anthropic',
          model: 'claude-test',
          approvalPolicy: 'ask',
          messages: [{ role: 'user', content: 'write both files' }]
        },
        send,
        (m) => {
          messages = m
        }
      )

      // No tool_use is left without a result.
      expect(missingToolResults(messages)).toEqual([])
      const r1 = messages.find((m) => m.role === 'tool' && m.toolCallId === 'w1')
      const r2 = messages.find((m) => m.role === 'tool' && m.toolCallId === 'w2')
      expect(r1).toBeTruthy()
      expect(r2).toBeTruthy()
      // The un-run second call carries the interruption placeholder.
      expect(r2?.content).toBe(INTERRUPTED_TOOL_RESULT)
      // Neither file was actually written.
      expect(existsSync(join(ws, 'a.txt'))).toBe(false)
      expect(existsSync(join(ws, 'b.txt'))).toBe(false)
    })

    it('preserves already-completed real outputs when a sequential turn is stopped mid-sequence', async () => {
      // Two writes in one turn under full-auto (no approval prompts, so both run
      // without blocking). Stop the run the moment the FIRST write's result is
      // emitted: the second iteration's abort check returns before it runs. Because
      // each result is flushed INLINE, the first write's real output must survive —
      // only the un-run second call gets the interrupted placeholder. Guards against
      // the abort-drops-completed-outputs regression (which risked duplicated side
      // effects on continuation).
      h.provider = scripted([
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'a.txt', content: 'DONE' } } },
          { type: 'tool_call', call: { id: 'w2', name: 'write_file', arguments: { path: 'b.txt', content: 'NEVER' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ])
      const runId = 'run-stop-mid-sequential'
      let messages: ChatMessage[] = []
      const send = (e: AgentEvent): void => {
        // Stop the instant the first write's result is emitted — synchronously, so
        // the abort signal is set before the second call's top-of-loop abort check
        // runs (mirrors the renderer stopping between two streamed results).
        if (e.type === 'tool_result' && e.callId === 'w1') cancelRun(runId)
      }
      await startRun(
        {
          runId,
          workspace: ws,
          providerId: 'anthropic',
          model: 'claude-test',
          approvalPolicy: 'full-auto',
          messages: [{ role: 'user', content: 'write both files' }]
        },
        send,
        (m) => {
          messages = m
        }
      )

      // The first write really happened and its result is the REAL output, not the
      // interrupted placeholder.
      expect(existsSync(join(ws, 'a.txt'))).toBe(true)
      const r1 = messages.find((m) => m.role === 'tool' && m.toolCallId === 'w1')
      expect(r1?.content).not.toBe(INTERRUPTED_TOOL_RESULT)
      expect(r1?.content).toContain('a.txt')

      // The second write never ran; it carries the interruption placeholder and the
      // file was never created (no duplicate side effect on continuation).
      expect(missingToolResults(messages)).toEqual([])
      const r2 = messages.find((m) => m.role === 'tool' && m.toolCallId === 'w2')
      expect(r2?.content).toBe(INTERRUPTED_TOOL_RESULT)
      expect(existsSync(join(ws, 'b.txt'))).toBe(false)
    })
  })

  describe('pending-prompt replay', () => {
    it('exposes a blocking approval for re-adopt, then clears it once resolved', async () => {
      h.provider = scripted([
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'wrote it' }, { type: 'done', stopReason: 'end_turn' }]
      ])
      const runId = 'run-pending-approval'
      const conversationId = 'conv-pending-approval'
      let promptsWhileBlocked: AgentEvent[] = []
      const send = (e: AgentEvent): void => {
        if (e.type === 'tool_approval') {
          // Snapshot what a re-opening renderer would replay while the run blocks.
          promptsWhileBlocked = pendingPromptsForConversation(conversationId)
          setTimeout(() => resolveApproval(runId, e.callId, 'allow'), 0)
        }
      }
      await startRun(
        {
          runId,
          conversationId,
          workspace: ws,
          providerId: 'anthropic',
          model: 'claude-test',
          approvalPolicy: 'ask',
          messages: [{ role: 'user', content: 'write it' }]
        },
        send
      )

      expect(promptsWhileBlocked).toHaveLength(1)
      expect(promptsWhileBlocked[0]).toMatchObject({
        type: 'tool_approval',
        callId: 'w1',
        name: 'write_file',
        kind: 'write',
        runId
      })
      // Resolved, and the run has ended — nothing is left pending.
      expect(pendingPromptsForConversation(conversationId)).toEqual([])
    })

    it('exposes a blocking ask_user question for re-adopt, then clears it once answered', async () => {
      h.provider = scripted([
        [
          {
            type: 'tool_call',
            call: { id: 'q1', name: 'ask_user', arguments: { question: 'Which option?', options: ['A', 'B'] } }
          },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
      ])
      const runId = 'run-pending-question'
      const conversationId = 'conv-pending-question'
      let promptsWhileBlocked: AgentEvent[] = []
      const send = (e: AgentEvent): void => {
        if (e.type === 'tool_question') {
          promptsWhileBlocked = pendingPromptsForConversation(conversationId)
          setTimeout(() => resolveQuestion(runId, e.callId, 'A'), 0)
        }
      }
      await startRun(
        {
          runId,
          conversationId,
          workspace: ws,
          providerId: 'anthropic',
          model: 'claude-test',
          approvalPolicy: 'ask',
          messages: [{ role: 'user', content: 'go' }]
        },
        send
      )

      expect(promptsWhileBlocked).toHaveLength(1)
      expect(promptsWhileBlocked[0]).toMatchObject({
        type: 'tool_question',
        callId: 'q1',
        question: 'Which option?',
        runId
      })
      expect(pendingPromptsForConversation(conversationId)).toEqual([])
    })

    it('clears a pending approval when the run is cancelled', async () => {
      h.provider = scripted([
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ])
      const runId = 'run-cancel-pending'
      const conversationId = 'conv-cancel-pending'
      const send = (e: AgentEvent): void => {
        if (e.type === 'tool_approval') setTimeout(() => cancelRun(runId), 0)
      }
      await startRun(
        {
          runId,
          conversationId,
          workspace: ws,
          providerId: 'anthropic',
          model: 'claude-test',
          approvalPolicy: 'ask',
          messages: [{ role: 'user', content: 'write it' }]
        },
        send
      )
      expect(pendingPromptsForConversation(conversationId)).toEqual([])
    })

    it('returns nothing for a conversation with no live run', () => {
      expect(pendingPromptsForConversation('no-such-conversation')).toEqual([])
    })
  })
})

describe('dispatch_writable_agent', () => {
  it('is approval-gated (kind:write) and runs a subagent that can edit files', async () => {
    const r = await run({
      turns: [
        // main: delegate a writable task
        [
          { type: 'tool_call', call: { id: 'd1', name: 'dispatch_writable_agent', arguments: { description: 'write file', prompt: 'create out.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        // subagent: write the file
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'from subagent' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        // subagent: report back
        [{ type: 'text', text: 'wrote out.txt' }, { type: 'done', stopReason: 'end_turn' }],
        // main: finish
        [{ type: 'text', text: 'delegated and done' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      policy: 'ask',
      onApproval: (_id, decide) => decide('allow')
    })
    const approval = r.events.find((e) => e.type === 'tool_approval')
    expect(approval && 'name' in approval ? approval.name : '').toBe('dispatch_writable_agent')
    expect(approval && 'kind' in approval ? approval.kind : '').toBe('write')
    expect(existsSync(join(ws, 'out.txt'))).toBe(true)
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('from subagent')
  })

  it('rejects an unknown named agent without running it', async () => {
    const r = await run({
      turns: [
        [
          { type: 'tool_call', call: { id: 'd1', name: 'dispatch_writable_agent', arguments: { description: 'x', prompt: 'do', agent: 'nope' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      policy: 'full-auto'
    })
    const toolMsg = r.messages.find((m) => m.role === 'tool' && m.toolName === 'dispatch_writable_agent')
    expect(typeof toolMsg?.content === 'string' && toolMsg.content).toContain('Unknown agent')
  })
})

describe('present_plan (Plan mode review)', () => {
  const planBody =
    '## Overview\nKeep an unsent message per chat.\n\n1. Add a `draft` field\n2. Restore it on open'
  const planTurn = [
    {
      type: 'tool_call' as const,
      call: {
        id: 'p1',
        name: 'present_plan',
        arguments: {
          title: 'Persist the composer draft',
          plan: planBody,
          files: ['src/main/conversations.ts', 'src/renderer/src/hooks/useChat.ts']
        }
      }
    },
    { type: 'done' as const, stopReason: 'tool_use' as const }
  ]

  it('emits plan_ready with the freeform payload', async () => {
    const r = await run({
      policy: 'plan',
      turns: [planTurn, [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]],
      onPlan: (_id, _plan, decide) => decide({ kind: 'reject' })
    })
    const ready = r.events.find((e) => e.type === 'plan_ready') as
      | { plan: PlanPayload; callId: string }
      | undefined
    expect(ready?.callId).toBe('p1')
    expect(ready?.plan).toEqual({
      title: 'Persist the composer draft',
      body: planBody,
      files: ['src/main/conversations.ts', 'src/renderer/src/hooks/useChat.ts']
    })
  })

  it('accepting switches off Plan mode so a following write is applied', async () => {
    const r = await run({
      policy: 'plan',
      turns: [
        planTurn,
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'out.txt', content: 'hi' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onPlan: (_id, _plan, decide) => decide({ kind: 'accept', mode: 'auto-edit' })
    })
    // The plan's tool result records acceptance...
    const planResult = r.events.find((e) => e.type === 'tool_result' && e.name === 'present_plan') as
      | { output: string }
      | undefined
    expect(planResult?.output).toMatch(/ACCEPTED/)
    // ...and the subsequent write ran (auto-edit auto-approves it — no prompt).
    expect(types(r)).not.toContain('tool_approval')
    expect(readFileSync(join(ws, 'out.txt'), 'utf8')).toBe('hi')
  })

  it('accepting with "ask" mode approves each following edit rather than auto-applying', async () => {
    const r = await run({
      policy: 'plan',
      turns: [
        planTurn,
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'ask.txt', content: 'hi' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onPlan: (_id, _plan, decide) => decide({ kind: 'accept', mode: 'ask' }),
      onApproval: (_id, decide) => decide('allow')
    })
    // 'ask' means the write now prompts (no longer read-only-blocked), then applies.
    expect(types(r)).toContain('tool_approval')
    expect(readFileSync(join(ws, 'ask.txt'), 'utf8')).toBe('hi')
  })

  it('rejecting keeps Plan mode so a following write stays blocked', async () => {
    const r = await run({
      policy: 'plan',
      turns: [
        planTurn,
        [
          { type: 'tool_call', call: { id: 'w1', name: 'write_file', arguments: { path: 'nope.txt', content: 'x' } } },
          { type: 'done', stopReason: 'tool_use' }
        ]
      ],
      onPlan: (_id, _plan, decide) => decide({ kind: 'reject' })
    })
    const planResult = r.events.find((e) => e.type === 'tool_result' && e.name === 'present_plan') as
      | { output: string }
      | undefined
    expect(planResult?.output).toMatch(/REJECTED/)
    expect(existsSync(join(ws, 'nope.txt'))).toBe(false)
    const writeResult = r.events.find((e) => e.type === 'tool_result' && e.name === 'write_file') as
      | { output: string }
      | undefined
    expect(writeResult?.output).toMatch(/Plan mode/)
  })

  it('suggesting feeds the note back and stays in Plan mode', async () => {
    const r = await run({
      policy: 'plan',
      turns: [planTurn, [{ type: 'text', text: 'revised' }, { type: 'done', stopReason: 'end_turn' }]],
      onPlan: (_id, _plan, decide) => decide({ kind: 'suggest', note: 'Debounce at 250ms.' })
    })
    const planResult = r.events.find((e) => e.type === 'tool_result' && e.name === 'present_plan') as
      | { output: string }
      | undefined
    expect(planResult?.output).toContain('Debounce at 250ms.')
    expect(planResult?.output).toMatch(/Plan mode/)
  })

  it('offers the present_plan tool only in Plan mode', async () => {
    const toolsSeen: string[][] = []
    const recorder: Provider = {
      async *streamChat(req) {
        toolsSeen.push((req.tools ?? []).map((t) => t.name))
        yield { type: 'text', text: 'ok' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    await run({ provider: recorder, policy: 'plan' })
    await run({ provider: recorder, policy: 'ask' })
    expect(toolsSeen[0]).toContain('present_plan')
    expect(toolsSeen[1]).not.toContain('present_plan')
  })

  it('replays a blocking plan for re-adopt, then clears it once resolved', async () => {
    const conversationId = 'conv-pending-plan'
    let promptsWhileBlocked: AgentEvent[] = []
    await run({
      conversationId,
      policy: 'plan',
      turns: [planTurn, [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]],
      onPlan: (_id, _plan, decide) => {
        promptsWhileBlocked = pendingPromptsForConversation(conversationId)
        decide({ kind: 'reject' })
      }
    })
    expect(promptsWhileBlocked).toHaveLength(1)
    expect(promptsWhileBlocked[0]).toMatchObject({ type: 'plan_ready', callId: 'p1' })
    expect(pendingPromptsForConversation(conversationId)).toEqual([])
  })

  it('accepts present_plan when the model passes files as a stringified array', async () => {
    // The reported failure: a model emits files as a JSON string, not an array. The
    // arg-coercion pass fixes it so present_plan runs instead of being refused.
    const r = await run({
      policy: 'plan',
      turns: [
        [
          {
            type: 'tool_call',
            call: {
              id: 'p1',
              name: 'present_plan',
              arguments: { title: 'X', plan: 'do it', files: '["a.ts", "b.ts"]' }
            }
          },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
      ],
      onPlan: (_id, _plan, decide) => decide({ kind: 'reject' })
    })
    const ready = r.events.find((e) => e.type === 'plan_ready') as
      | { plan: PlanPayload }
      | undefined
    expect(ready?.plan.files).toEqual(['a.ts', 'b.ts'])
    // It ran (a real result), rather than being bounced with a validation error.
    const result = r.events.find((e) => e.type === 'tool_result' && e.name === 'present_plan') as
      | { output: string; ok: boolean }
      | undefined
    expect(result?.output).not.toMatch(/Invalid arguments/)
  })

  it('recovers from an interrupted present_plan: never sends an orphaned tool_use', async () => {
    // A prior run quit while the plan was pending (tool_use persisted, no result),
    // then the user re-sent a message — so a user turn now sits after the dangling
    // present_plan. This must not 400: the window sent to the provider, and the
    // persisted log, are both normalized so the tool_use is paired.
    let sent: ChatMessage[] | undefined
    const recorder: Provider = {
      async *streamChat(req) {
        sent = req.messages
        yield { type: 'text', text: 'here it is again' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
    }
    const seeded: ChatMessage[] = [
      { role: 'user', content: 'plan it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'p1', name: 'present_plan', arguments: { title: 'X', plan: 'do it' } }]
      },
      { role: 'user', content: 'resurface the plan again please' }
    ]
    const r = await run({ provider: recorder, policy: 'plan', messages: seeded })
    expect(orphanedToolUses(sent ?? [])).toEqual([]) // the request the provider saw
    expect(orphanedToolUses(r.messages)).toEqual([]) // the healed, persisted log
    // The dangling call was paired with the interruption placeholder.
    const filled = r.messages.find((m) => m.role === 'tool' && m.toolCallId === 'p1')
    expect(filled?.content).toBe(INTERRUPTED_TOOL_RESULT)
  })

  it('unblocks a pending plan when the run is cancelled', async () => {
    h.provider = scripted([planTurn])
    const runId = 'run-cancel-plan'
    const events: AgentEvent[] = []
    const send = (e: AgentEvent): void => {
      events.push(e)
      if (e.type === 'plan_ready') setTimeout(() => cancelRun(runId), 0)
    }
    await startRun(
      {
        runId,
        workspace: ws,
        providerId: 'anthropic',
        model: 'claude-test',
        approvalPolicy: 'plan',
        messages: [{ role: 'user', content: 'plan it' }]
      },
      send
    )
    // The run terminated (no hang), having surfaced the plan first.
    expect(events.some((e) => e.type === 'plan_ready')).toBe(true)
    expect(events.at(-1)?.type).toBe('done')
  })
})
