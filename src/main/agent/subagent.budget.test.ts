import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import type { SubagentBudget, SubagentStatus, SubagentStep } from '@shared/subagents'
import { runSubAgent, SUBAGENT_FINAL_STEP_NOTE } from './subagent'
import { clearCheckpoints } from './checkpoints'

let ws: string

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'houston-sub-budget-'))
})
afterEach(() => {
  clearCheckpoints()
  rmSync(ws, { recursive: true, force: true })
})

/** Each call yields the next scripted turn; records every request it saw. */
function scripted(turns: ProviderStreamEvent[][], seen: ChatRequest[] = []): Provider {
  let i = 0
  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      seen.push({ ...req, messages: [...req.messages] })
      const turn = turns[i++] ?? [{ type: 'done', stopReason: 'end_turn' }]
      for (const ev of turn) yield ev
    }
  }
}

/** A provider that calls `call(n)` on every turn, forever. */
function looping(call: (n: number) => { name: string; arguments: Record<string, unknown> }, seen: ChatRequest[] = []): Provider {
  let n = 0
  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      seen.push({ ...req, messages: [...req.messages] })
      const c = call(n++)
      yield { type: 'tool_call', call: { id: `c${n}`, ...c } }
      yield { type: 'done', stopReason: 'tool_use' }
    }
  }
}

function collect(): {
  steps: SubagentStep[]
  end: { status: SubagentStatus; budget: SubagentBudget } | null
  start: { system: string; tools: string[] } | null
} {
  return { steps: [], end: null, start: null }
}

const base = { model: 'm', prompt: 'investigate', signal: new AbortController().signal }

describe('subagent steps', () => {
  it('reports each tool call as it starts and when it finishes, with an outcome', async () => {
    writeFileSync(join(ws, 'a.txt'), 'one\ntwo\nthree\n')
    const got = collect()
    const report = await runSubAgent({
      ...base,
      workspace: ws,
      provider: scripted([
        [
          { type: 'text', text: 'Reading the file first.' },
          { type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'a.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [
          { type: 'text', text: '## Found\nthree lines' },
          { type: 'done', stopReason: 'end_turn' }
        ]
      ]),
      onStart: (s) => (got.start = s),
      onStep: (s) => got.steps.push(s),
      onEnd: (e) => (got.end = e)
    })
    expect(report).toBe('## Found\nthree lines')
    expect(got.start?.tools).toContain('read_file')
    expect(got.start?.system).toContain('research subagent')
    // The interim text, then the call as it started, then the same index finished.
    expect(got.steps[0]).toMatchObject({ kind: 'text', turn: 1, summary: 'Reading the file first.' })
    const started = got.steps[1]
    const finished = got.steps[2]
    expect(started).toMatchObject({ kind: 'tool', tool: 'read_file', turn: 1 })
    expect(started.ok).toBeUndefined()
    expect(finished.index).toBe(started.index)
    expect(finished.ok).toBe(true)
    expect(finished.hint).toMatch(/lines?$/)
    expect(finished.output).toContain('two')
    expect(got.end).toEqual({ status: 'done', budget: { used: 2, limit: 40, ceiling: 200 } })
  })

  it('marks a refused call as failed and redacts what it records', async () => {
    const secret = 'sk-test-abcdefghijklmnopqrstuvwx1234567890'
    writeFileSync(join(ws, 'k.txt'), `key=${secret}\n`)
    const got = collect()
    await runSubAgent({
      ...base,
      workspace: ws,
      redact: (t) => t.split(secret).join('[redacted]'),
      provider: scripted([
        [
          { type: 'tool_call', call: { id: 'c1', name: 'run_shell', arguments: { command: 'ls' } } },
          { type: 'tool_call', call: { id: 'c2', name: 'read_file', arguments: { path: 'k.txt' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'ok' }, { type: 'done', stopReason: 'end_turn' }]
      ]),
      onStep: (s) => got.steps.push(s)
    })
    const shell = got.steps.filter((s) => s.tool === 'run_shell').at(-1)!
    expect(shell.ok).toBe(false)
    const read = got.steps.filter((s) => s.tool === 'read_file').at(-1)!
    expect(read.output).not.toContain(secret)
    expect(read.output).toContain('[redacted]')
  })

  it('carries a write’s real diff and line counts on its step', async () => {
    writeFileSync(join(ws, 'f.js'), 'const a = 1\nconst b = 2\n')
    const got = collect()
    await runSubAgent({
      ...base,
      workspace: ws,
      writable: true,
      shellSandboxed: true,
      provider: scripted([
        [{ type: 'tool_call', call: { id: 'c1', name: 'read_file', arguments: { path: 'f.js' } } }, { type: 'done', stopReason: 'tool_use' }],
        [
          {
            type: 'tool_call',
            call: { id: 'c2', name: 'edit_file', arguments: { path: 'f.js', old_string: 'const b = 2', new_string: 'const b = 3' } }
          },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'changed b' }, { type: 'done', stopReason: 'end_turn' }]
      ]),
      onStep: (s) => got.steps.push(s)
    })
    const edit = got.steps.filter((s) => s.tool === 'edit_file').at(-1)!
    expect(edit.ok).toBe(true)
    expect(edit.hint).toBe('+1 −1')
    expect(edit.preview?.[0].path).toBe('f.js')
    expect(edit.preview?.[0].diff.some((l) => l.type === 'add' && l.text.includes('const b = 3'))).toBe(true)
  })

  it('tells a nested dispatch which step started it', async () => {
    const indexes: (number | undefined)[] = []
    const got = collect()
    await runSubAgent({
      ...base,
      workspace: ws,
      dispatchNested: async (_p, _a, _m, stepIndex) => {
        indexes.push(stepIndex)
        return 'nested report'
      },
      provider: scripted([
        [
          { type: 'tool_call', call: { id: 'c1', name: 'dispatch_agent', arguments: { description: 'x', prompt: 'look' } } },
          { type: 'done', stopReason: 'tool_use' }
        ],
        [{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }]
      ]),
      onStep: (s) => got.steps.push(s)
    })
    const dispatch = got.steps.find((s) => s.tool === 'dispatch_agent')!
    expect(indexes).toEqual([dispatch.index])
    // The nested agent's own record carries its work; the step keeps no raw output.
    expect(got.steps.filter((s) => s.tool === 'dispatch_agent').at(-1)!.output).toBeUndefined()
  })
})

describe('subagent step budget', () => {
  it('has no fixed 16-step cap: a productive run extends, says so, and stops at the ceiling', async () => {
    for (let i = 0; i < 40; i++) writeFileSync(join(ws, `f${i}.txt`), `file ${i}\n`)
    const got = collect()
    const seen: ChatRequest[] = []
    const report = await runSubAgent({
      ...base,
      workspace: ws,
      budget: { maxIterations: 8, ceiling: 24 },
      provider: looping((n) => ({ name: 'read_file', arguments: { path: `f${n}.txt` } }), seen),
      onStep: (s) => got.steps.push(s),
      onEnd: (e) => (got.end = e)
    })
    expect(seen.length).toBe(24)
    expect(got.end?.status).toBe('step-limit')
    expect(got.end?.budget).toMatchObject({ used: 24, limit: 24, ceiling: 24 })
    const notices = got.steps.filter((s) => s.kind === 'notice').map((s) => s.summary)
    expect(notices.some((n) => /grew to 16/.test(n))).toBe(true)
    expect(notices.some((n) => /grew to 24/.test(n))).toBe(true)
    // The last request told it its tools won't run; it reported what it had.
    const last = seen.at(-1)!.messages
    expect(last.some((m) => typeof m.content === 'string' && m.content.includes(SUBAGENT_FINAL_STEP_NOTE))).toBe(true)
    expect(report).toMatch(/step limit/)
  })

  it('stops at the base cap when extension is off, ending on its report', async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(ws, `f${i}.txt`), `file ${i}\n`)
    const got = collect()
    const seen: ChatRequest[] = []
    let n = 0
    const provider: Provider = {
      async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
        seen.push({ ...req, messages: [...req.messages] })
        n++
        yield { type: 'text', text: n === 5 ? 'Partial findings so far.' : '' }
        yield { type: 'tool_call', call: { id: `c${n}`, name: 'read_file', arguments: { path: `f${n}.txt` } } }
        yield { type: 'done', stopReason: 'tool_use' }
      }
    }
    const messages: ChatMessage[][] = []
    const report = await runSubAgent({
      ...base,
      workspace: ws,
      budget: { maxIterations: 5, autoExtend: false },
      provider,
      onEnd: (e) => (got.end = e),
      onTranscript: (m) => messages.push(m)
    })
    expect(seen.length).toBe(5)
    expect(got.end).toEqual({ status: 'step-limit', budget: { used: 5, limit: 5, ceiling: 5 } })
    expect(report).toContain('Partial findings so far.')
    // The dropped last-step call never ran and isn't left dangling in the transcript.
    const transcript = messages[0]
    const lastAssistant = [...transcript].reverse().find((m) => m.role === 'assistant')!
    expect(lastAssistant.toolCalls).toBeUndefined()
    // A landing reminder came first.
    expect(seen[3].messages.some((m) => typeof m.content === 'string' && m.content.includes('Wrap up'))).toBe(true)
  })

  it('treats a custom agent’s max_turns as a hard limit that never extends', async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(ws, `f${i}.txt`), `file ${i}\n`)
    const got = collect()
    const seen: ChatRequest[] = []
    await runSubAgent({
      ...base,
      workspace: ws,
      budget: { maxIterations: 40, ceiling: 200, hardCap: 3 },
      provider: looping((n) => ({ name: 'read_file', arguments: { path: `f${n}.txt` } }), seen),
      onEnd: (e) => (got.end = e)
    })
    expect(seen.length).toBe(3)
    expect(got.end).toEqual({ status: 'step-limit', budget: { used: 3, limit: 3, ceiling: 3, hardCap: 3 } })
  })

  it('a last step with no text and only tool calls leaves no empty assistant turn', async () => {
    const messages: ChatMessage[][] = []
    const report = await runSubAgent({
      ...base,
      workspace: ws,
      budget: { maxIterations: 2, autoExtend: false },
      provider: looping(() => ({ name: 'list_dir', arguments: { path: '.' } })),
      onTranscript: (m) => messages.push(m)
    })
    expect(report).toBe('[subagent reached its step limit without a final answer]')
    expect(messages[0].some((m) => m.role === 'assistant' && !m.content && !m.toolCalls)).toBe(false)
  })
})

describe('subagent loop detection', () => {
  it('nudges a repeating agent once, then stops it with what it has', async () => {
    const got = collect()
    const report = await runSubAgent({
      ...base,
      workspace: ws,
      provider: looping(() => ({ name: 'read_file', arguments: { path: 'missing.txt' } })),
      onStep: (s) => got.steps.push(s),
      onEnd: (e) => (got.end = e)
    })
    expect(got.end?.status).toBe('stalled')
    expect(got.steps.some((s) => s.kind === 'notice' && /Repeating itself/.test(s.summary))).toBe(true)
    expect(report).toMatch(/kept repeating/)
  })

  it('can be turned off', async () => {
    const got = collect()
    await runSubAgent({
      ...base,
      workspace: ws,
      stall: false,
      budget: { maxIterations: 8, autoExtend: false },
      provider: looping(() => ({ name: 'read_file', arguments: { path: 'missing.txt' } })),
      onEnd: (e) => (got.end = e)
    })
    expect(got.end?.status).toBe('step-limit')
  })
})

describe('subagent context', () => {
  it('stubs stale large tool results out of the request near the context window, keeping its transcript', async () => {
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(12_000))
    for (let i = 0; i < 8; i++) writeFileSync(join(ws, `s${i}.txt`), `small ${i}\n`)
    const seen: ChatRequest[] = []
    const turns: ProviderStreamEvent[][] = [
      [{ type: 'tool_call', call: { id: 'b', name: 'read_file', arguments: { path: 'big.txt' } } }, { type: 'done', stopReason: 'tool_use' }]
    ]
    for (let i = 0; i < 6; i++) {
      turns.push([
        { type: 'tool_call', call: { id: `s${i}`, name: 'read_file', arguments: { path: `s${i}.txt` } } },
        { type: 'done', stopReason: 'tool_use' }
      ])
    }
    turns.push([{ type: 'text', text: 'done' }, { type: 'done', stopReason: 'end_turn' }])
    const transcripts: ChatMessage[][] = []
    await runSubAgent({
      ...base,
      workspace: ws,
      contextWindow: 4_000,
      provider: scripted(turns, seen),
      onTranscript: (m) => transcripts.push(m)
    })
    const lastReq = seen.at(-1)!.messages
    const big = lastReq.find((m) => m.role === 'tool' && m.toolCallId === 'b')!
    expect(big.content).toMatch(/bytes elided/)
    const kept = transcripts[0].find((m) => m.role === 'tool' && m.toolCallId === 'b')!
    expect(kept.content.length).toBeGreaterThan(10_000)
  })
})
