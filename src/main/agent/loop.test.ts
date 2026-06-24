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
const { startRun, resolveApproval, setRunPolicy } = await import('./loop')

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
