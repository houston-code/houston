import { describe, it, expect } from 'vitest'
import type { ChatMessage } from './agent'
import {
  buildScorecard,
  deriveOutcome,
  type ScorecardConversationInput
} from './scorecard'

// ---- fixture builders (synthetic only — never real user data) ----

const user = (content = 'hi'): ChatMessage => ({ role: 'user', content })
const assistant = (content = 'ok', toolCalls?: ChatMessage['toolCalls']): ChatMessage => ({
  role: 'assistant',
  content,
  ...(toolCalls ? { toolCalls } : {})
})
const toolTurn = (toolName: string): ChatMessage => ({
  role: 'tool',
  content: 'result',
  toolName,
  toolCallId: `${toolName}-1`
})

function conv(partial: Partial<ScorecardConversationInput>): ScorecardConversationInput {
  return {
    model: partial.model ?? 'claude-test',
    messages: partial.messages ?? [],
    usage: partial.usage,
    errored: partial.errored
  }
}

describe('deriveOutcome', () => {
  it('is error when the errored flag is set (even on a clean-looking log)', () => {
    expect(deriveOutcome(conv({ messages: [user(), assistant('done')], errored: true }))).toBe(
      'error'
    )
  })

  it('is completed when the log ends on an assistant turn with no tool calls', () => {
    expect(deriveOutcome(conv({ messages: [user(), assistant('all set')] }))).toBe('completed')
  })

  it('is incomplete when the log ends on an assistant turn that still requests tools', () => {
    const withCall = assistant('running…', [{ id: 't1', name: 'read_file', arguments: {} }])
    expect(deriveOutcome(conv({ messages: [user(), withCall] }))).toBe('incomplete')
  })

  it('is incomplete when the log ends mid tool result (aborted / still running)', () => {
    expect(deriveOutcome(conv({ messages: [user(), toolTurn('run_shell')] }))).toBe('incomplete')
  })

  it('is incomplete for an empty log', () => {
    expect(deriveOutcome(conv({ messages: [] }))).toBe('incomplete')
  })

  it('ignores a trailing user turn (queued after the run) when inferring outcome', () => {
    const msgs = [user(), assistant('done'), user('queued follow-up')]
    expect(deriveOutcome(conv({ messages: msgs }))).toBe('completed')
  })
})

describe('buildScorecard', () => {
  it('returns an empty scorecard for no conversations', () => {
    const s = buildScorecard([])
    expect(s.models).toEqual([])
    expect(s.totalRuns).toBe(0)
    expect(s.totalCost).toBe(0)
  })

  it('skips never-ran placeholders (empty log and no usage)', () => {
    const s = buildScorecard([conv({ model: 'claude-opus', messages: [] })])
    expect(s.totalRuns).toBe(0)
    expect(s.models).toEqual([])
  })

  it('groups by model and averages steps and tool calls per run', () => {
    const runA = conv({
      model: 'claude-opus',
      messages: [user(), assistant('', [{ id: 'a', name: 'read_file', arguments: {} }]), toolTurn('read_file'), assistant('done')],
      usage: { inputTokens: 100, outputTokens: 50, cost: 0.01 }
    })
    const runB = conv({
      model: 'claude-opus',
      messages: [user(), assistant('done')],
      usage: { inputTokens: 80, outputTokens: 30, cost: 0.005 }
    })
    const s = buildScorecard([runA, runB])
    expect(s.models).toHaveLength(1)
    const row = s.models[0]
    expect(row.model).toBe('claude-opus')
    expect(row.runs).toBe(2)
    // runA has 2 assistant turns, runB has 1 => 3 total, avg 1.5
    expect(row.totalSteps).toBe(3)
    expect(row.avgSteps).toBe(1.5)
    // one tool turn total across both runs
    expect(row.totalToolCalls).toBe(1)
    expect(row.avgToolCalls).toBe(0.5)
    expect(row.totalOutputTokens).toBe(80) // 50 + 30, output is cumulative
    expect(row.totalCost).toBeCloseTo(0.015, 6)
    expect(row.avgCost).toBeCloseTo(0.0075, 6)
    expect(s.totalRuns).toBe(2)
  })

  it('does NOT sum inputTokens across runs (it is per-turn context, not cumulative)', () => {
    const s = buildScorecard([
      conv({ model: 'm', messages: [user(), assistant('x')], usage: { inputTokens: 500, outputTokens: 10, cost: 0.001 } }),
      conv({ model: 'm', messages: [user(), assistant('y')], usage: { inputTokens: 900, outputTokens: 20, cost: 0.002 } })
    ])
    const row = s.models[0]
    expect(row.totalOutputTokens).toBe(30)
    // No field on the row exposes summed input tokens — assert it isn't leaking in via cost math.
    expect(row.totalCost).toBeCloseTo(0.003, 6)
  })

  it('computes completion rate from inferred outcomes', () => {
    const completed = conv({ model: 'm', messages: [user(), assistant('done')], usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } })
    const errored = conv({ model: 'm', messages: [user(), assistant('boom')], usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 }, errored: true })
    const cutOff = conv({ model: 'm', messages: [user(), toolTurn('run_shell')], usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } })
    const s = buildScorecard([completed, errored, cutOff])
    const row = s.models[0]
    expect(row.runs).toBe(3)
    expect(row.completedRuns).toBe(1)
    expect(row.limitedRuns).toBe(2)
    expect(row.completionRate).toBeCloseTo(1 / 3, 4)
  })

  it('builds a tool-usage histogram sorted by count desc then name', () => {
    const messages = [
      user(),
      assistant('', [{ id: '1', name: 'read_file', arguments: {} }]),
      toolTurn('read_file'),
      toolTurn('read_file'),
      toolTurn('run_shell'),
      toolTurn('edit_file'),
      assistant('done')
    ]
    const s = buildScorecard([conv({ model: 'm', messages, usage: { inputTokens: 1, outputTokens: 5, cost: 0.001 } })])
    expect(s.models[0].tools).toEqual([
      { name: 'read_file', count: 2 },
      { name: 'edit_file', count: 1 },
      { name: 'run_shell', count: 1 }
    ])
  })

  it('buckets an unnamed tool turn under "unknown" rather than dropping it', () => {
    const messages = [user(), { role: 'tool', content: 'r' } as ChatMessage, assistant('done')]
    const s = buildScorecard([conv({ model: 'm', messages, usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } })])
    expect(s.models[0].tools).toEqual([{ name: 'unknown', count: 1 }])
    expect(s.models[0].totalToolCalls).toBe(1)
  })

  it('falls back to a fresh cost estimate when no cost was persisted', () => {
    // opus pricing: input $5/MTok, output $25/MTok. 1M in + 1M out => $30.
    const s = buildScorecard([
      conv({ model: 'claude-opus', messages: [user(), assistant('x')], usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cost: 0 } })
    ])
    expect(s.models[0].totalCost).toBeCloseTo(30, 2)
  })

  it('orders rows by total cost desc, then runs, then model id', () => {
    const cheap = conv({ model: 'cheap', messages: [user(), assistant('x')], usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } })
    const pricey = conv({ model: 'pricey', messages: [user(), assistant('x')], usage: { inputTokens: 1, outputTokens: 1, cost: 5 } })
    const s = buildScorecard([cheap, pricey])
    expect(s.models.map((m) => m.model)).toEqual(['pricey', 'cheap'])
    expect(s.totalCost).toBeCloseTo(5.001, 4)
  })

  it('counts a conversation with usage but an empty log as a real run', () => {
    const s = buildScorecard([conv({ model: 'm', messages: [], usage: { inputTokens: 10, outputTokens: 5, cost: 0.002 } })])
    expect(s.totalRuns).toBe(1)
    expect(s.models[0].runs).toBe(1)
    expect(s.models[0].totalSteps).toBe(0)
  })

  it('handles a missing model id by bucketing under "unknown"', () => {
    const s = buildScorecard([conv({ model: '', messages: [user(), assistant('x')], usage: { inputTokens: 1, outputTokens: 1, cost: 0.001 } })])
    expect(s.models[0].model).toBe('unknown')
  })
})
