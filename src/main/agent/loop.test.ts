import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, ChatMessage, Provider, ProviderStreamEvent } from '@shared/agent'
import type { ApprovalPolicy } from '@shared/types'

// Hoisted holders the mocks read, so each test can swap the fake provider/settings.
const h = vi.hoisted(() => ({
  provider: null as Provider | null,
  settings: {
    compactionThreshold: 0,
    reasoningEffort: 'off',
    permissionRules: [],
    hooks: [],
    mcpServers: [],
    additionalRoots: []
  } as Record<string, unknown>
}))

vi.mock('../store', () => ({
  getSettings: () => h.settings,
  getProvider: () => ({
    id: 'anthropic',
    kind: 'anthropic',
    label: 'A',
    models: [],
    requiresKey: false,
    hasKey: true,
    builtIn: true
  })
}))
vi.mock('../secrets', () => ({ getKey: () => null }))
vi.mock('../providers', () => ({ createProvider: () => h.provider }))
vi.mock('../mcp/manager', () => ({ getMcpToolDefs: async () => [] }))
vi.mock('./git', () => ({ gitContext: async () => '' }))
vi.mock('./review', () => ({ reviewWorkspaceChanges: async () => 'no changes' }))

// Imported after the mocks are registered.
const { startRun, resolveApproval } = await import('./loop')

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
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
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
    onApproval?: (callId: string, decide: (d: 'allow' | 'deny' | 'always') => void) => void
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
  }
  await startRun(
    {
      runId,
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
    expect(mainSends[0][0].content).not.toContain('COMPACTED SUMMARY')
    expect(mainSends[1][0].content).toContain('COMPACTED SUMMARY')
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
})
