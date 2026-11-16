import { describe, it, expect } from 'vitest'
import type { ChatMessage, RunEndRecord } from './agent'
import {
  buildScorecard,
  deriveOutcome,
  emptyRunEndCounts,
  messageGroups,
  NO_REPLY_PROMPT_ID,
  runEndParts,
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
    errored: partial.errored,
    ...(partial.inherited !== undefined ? { inherited: partial.inherited } : {})
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

  it("counts only a chat's own messages after the history it copied", () => {
    const copied = [user(), assistant('', [{ id: 'a', name: 'read_file', arguments: {} }]), toolTurn('read_file'), assistant('done')]
    const unusedFork = conv({ model: 'm', messages: copied, inherited: 4, usage: { inputTokens: 900, outputTokens: 0, cost: 0 } })
    expect(buildScorecard([unusedFork]).totalRuns).toBe(0)

    const usedFork = conv({
      model: 'm',
      messages: [...copied, user(), assistant('more')],
      inherited: 4,
      usage: { inputTokens: 950, outputTokens: 20, cost: 0.002 }
    })
    const row = buildScorecard([usedFork]).models[0]
    expect(row.totalSteps).toBe(1)
    expect(row.totalToolCalls).toBe(0)
    expect(row.totalCost).toBeCloseTo(0.002, 6)
  })

  it('estimates no cost for a chat that never got an answer', () => {
    // Only a context size carried over, no output: nothing was spent here.
    const s = buildScorecard([conv({ model: 'claude-opus-4-1', messages: [user()], usage: { inputTokens: 50000, outputTokens: 0, cost: 0 } })])
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

  it('says what it grouped by, per model unless asked otherwise', () => {
    expect(buildScorecard([]).groupBy).toBe('model')
    expect(buildScorecard([], { groupBy: 'model-prompt' }).groupBy).toBe('model-prompt')
  })
})

// ---- what each reply and run recorded ----

const at = '2026-11-01T00:00:00.000Z'
const ended = (...records: Array<Omit<RunEndRecord, 'at'>>): RunEndRecord[] => records.map((r) => ({ ...r, at }))
/** A reply as the loop saves it now: the model that served it and the prompt version. */
const reply = (model: string, promptId?: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  role: 'assistant',
  content: 'ok',
  model,
  ...(promptId ? { promptId } : {}),
  ...extra
})
const call = (name: string, id = `${name}-1`): ChatMessage['toolCalls'] => [{ id, name, arguments: {} }]

describe('deriveOutcome with run-end records', () => {
  it('reads a step-limit stop on a plain text reply as incomplete, not a clean finish', () => {
    const msgs = [user(), { ...assistant('Halfway there.'), runEnds: ended({ reason: 'limit', limit: 'max-steps' }) }]
    expect(deriveOutcome(conv({ messages: msgs }))).toBe('incomplete')
  })

  it('reads a failed run as an error even with no errored flag', () => {
    const msgs = [user(), assistant('done'), { ...user('again'), runEnds: ended({ reason: 'error', message: 'boom' }) }]
    expect(deriveOutcome(conv({ messages: msgs }))).toBe('error')
  })

  it('reads a run the user stopped before any reply as incomplete', () => {
    const msgs = [user(), assistant('done'), { ...user('next'), runEnds: ended({ reason: 'aborted' }) }]
    expect(deriveOutcome(conv({ messages: msgs }))).toBe('incomplete')
  })

  it('reads the older no-reply record the same way', () => {
    const msgs = [{ ...user(), unanswered: [{ reason: 'error' as const, at }] }]
    expect(deriveOutcome(conv({ messages: msgs }))).toBe('error')
  })

  it('goes by the latest run: an earlier run that failed, then a clean reply, is completed', () => {
    const msgs = [{ ...user(), runEnds: ended({ reason: 'error' }) }, assistant('done')]
    expect(deriveOutcome(conv({ messages: msgs }))).toBe('completed')
  })
})

describe('buildScorecard run-end counts', () => {
  it('counts every run that stopped short, by why, per model', () => {
    const messages: ChatMessage[] = [
      { ...user('one'), runEnds: ended({ reason: 'error', message: 'provider down' }, { reason: 'aborted' }) },
      reply('m'),
      user('two'),
      { ...reply('m'), runEnds: ended({ reason: 'limit', limit: 'max-steps' }) },
      user('three'),
      { ...reply('m'), runEnds: ended({ reason: 'limit', limit: 'stalled' }) },
      user('four'),
      { ...reply('m'), runEnds: ended({ reason: 'limit', limit: 'max-cost' }, { reason: 'limit', limit: 'max-output' }) },
      // A limit saved without saying which reads as the step limit, as the notices do.
      { ...user('five'), runEnds: ended({ reason: 'limit' }) },
      // The older record of a run that got no reply.
      { ...user('six'), unanswered: [{ reason: 'aborted', at }] }
    ]
    const row = buildScorecard([conv({ model: 'm', messages })]).models[0]
    expect(row.runEnds).toEqual({
      error: 1,
      aborted: 2,
      limits: { 'max-steps': 2, stalled: 1, 'max-cost': 1, 'max-output': 1 }
    })
  })

  it('reports no stops for a chat whose runs all finished', () => {
    const row = buildScorecard([conv({ model: 'm', messages: [user(), assistant('done')] })]).models[0]
    expect(row.runEnds).toEqual(emptyRunEndCounts())
  })

  it("doesn't count the stops in a fork's copied history", () => {
    const copied = [user(), { ...reply('m'), runEnds: ended({ reason: 'error' }) }]
    const s = buildScorecard([conv({ model: 'm', messages: [...copied, user('more'), reply('m')], inherited: 2 })])
    expect(s.models[0].runEnds.error).toBe(0)
  })

  it('credits a stop to the model of the run that stopped', () => {
    const messages: ChatMessage[] = [
      user(),
      reply('old-model', undefined, { toolCalls: call('run_shell') }),
      { ...toolTurn('run_shell'), runEnds: ended({ reason: 'aborted' }) },
      user('switched'),
      { ...reply('new-model'), runEnds: ended({ reason: 'limit', limit: 'stalled' }) }
    ]
    const rows = buildScorecard([conv({ model: 'new-model', messages })]).models
    const by = Object.fromEntries(rows.map((r) => [r.model, r]))
    expect(by['old-model'].runEnds.aborted).toBe(1)
    expect(by['old-model'].runEnds.limits.stalled).toBe(0)
    expect(by['new-model'].runEnds.limits.stalled).toBe(1)
    expect(by['new-model'].runEnds.aborted).toBe(0)
  })

  it('credits a run that failed before any reply to the chat model', () => {
    const s = buildScorecard([conv({ model: 'misconfigured', messages: [{ ...user(), runEnds: ended({ reason: 'error' }) }] })])
    expect(s.models).toHaveLength(1)
    expect(s.models[0].model).toBe('misconfigured')
    expect(s.models[0].runEnds.error).toBe(1)
  })

  it('words the stops the same way for every client, leaving out the ones that never happened', () => {
    const c = emptyRunEndCounts()
    expect(runEndParts(c)).toEqual([])
    c.error = 2
    c.limits['max-steps'] = 1
    c.limits['max-cost'] = 3
    expect(runEndParts(c)).toEqual([
      { label: 'failed', count: 2 },
      { label: 'step limit', count: 1 },
      { label: 'cost limit', count: 3 }
    ])
  })
})

describe('buildScorecard per-reply models', () => {
  // A chat that started on one model and was switched: the chat names only the second.
  const switched = (): ScorecardConversationInput =>
    conv({
      model: 'model-b',
      messages: [
        user(),
        reply('model-a', undefined, { toolCalls: call('read_file'), usage: { inputTokens: 10, outputTokens: 100, cost: 0.4 } }),
        toolTurn('read_file'),
        reply('model-a', undefined, { usage: { inputTokens: 10, outputTokens: 50, cost: 0.2 } }),
        user('now with b'),
        reply('model-b', undefined, { toolCalls: call('run_shell'), usage: { inputTokens: 10, outputTokens: 30, cost: 0.1 } }),
        toolTurn('run_shell'),
        reply('model-b', undefined, { usage: { inputTokens: 10, outputTokens: 20, cost: 0.1 } })
      ],
      // The running total also holds a subagent's spend that no reply recorded.
      usage: { inputTokens: 10, outputTokens: 250, cost: 1 }
    })

  it("credits each reply's step, usage and tool calls to the model that wrote it", () => {
    const s = buildScorecard([switched()])
    const by = Object.fromEntries(s.models.map((r) => [r.model, r]))
    expect(by['model-a'].totalSteps).toBe(2)
    expect(by['model-a'].tools).toEqual([{ name: 'read_file', count: 1 }])
    expect(by['model-a'].totalCost).toBeCloseTo(0.6, 6)
    expect(by['model-a'].totalOutputTokens).toBe(150)
    expect(by['model-b'].totalSteps).toBe(2)
    expect(by['model-b'].tools).toEqual([{ name: 'run_shell', count: 1 }])
    // Its own replies (0.2) plus what the total holds beyond every reply (1 - 0.8).
    expect(by['model-b'].totalCost).toBeCloseTo(0.4, 6)
    expect(by['model-b'].totalOutputTokens).toBe(100)
  })

  it('counts the chat once in total but as a run for each model it used', () => {
    const s = buildScorecard([switched()])
    expect(s.totalRuns).toBe(1)
    expect(s.models.map((r) => r.runs)).toEqual([1, 1])
    expect(s.totalCost).toBeCloseTo(1, 6)
  })

  it("puts the latest run's outcome on the model that ran it, and rates finishes over those", () => {
    const by = Object.fromEntries(buildScorecard([switched()]).models.map((r) => [r.model, r]))
    expect(by['model-b'].completedRuns).toBe(1)
    expect(by['model-b'].completionRate).toBe(1)
    // model-a ran no chat's latest run: nothing to rate, rather than a 0% finish rate.
    expect(by['model-a'].completedRuns + by['model-a'].limitedRuns).toBe(0)
    expect(by['model-a'].completionRate).toBe(0)
  })

  it('falls back to the chat model for replies saved before they named one', () => {
    const s = buildScorecard([conv({ model: 'm', messages: [user(), assistant('old reply'), user(), reply('m')] })])
    expect(s.models).toHaveLength(1)
    expect(s.models[0].totalSteps).toBe(2)
  })
})

describe('buildScorecard by prompt version', () => {
  const chat = (): ScorecardConversationInput =>
    conv({
      model: 'm',
      messages: [
        user(),
        assistant('saved before prompt ids'),
        user(),
        reply('m', 'aaaaaaaaaaaa', { toolCalls: call('read_file') }),
        toolTurn('read_file'),
        { ...reply('m', 'aaaaaaaaaaaa'), runEnds: ended({ reason: 'limit', limit: 'max-steps' }) },
        user(),
        reply('m', 'bbbbbbbbbbbb', { usage: { inputTokens: 1, outputTokens: 5, cost: 0.01 } })
      ],
      usage: { inputTokens: 1, outputTokens: 5, cost: 0.01 }
    })

  it('splits each model into one row per prompt version, plus one for replies with none', () => {
    const s = buildScorecard([chat()], { groupBy: 'model-prompt' })
    const by = Object.fromEntries(s.models.map((r) => [r.promptId ?? '(none)', r]))
    expect(Object.keys(by).sort()).toEqual(['(none)', 'aaaaaaaaaaaa', 'bbbbbbbbbbbb'])
    expect(s.models.every((r) => r.model === 'm')).toBe(true)
    expect(by['(none)'].totalSteps).toBe(1)
    expect(by.aaaaaaaaaaaa.totalSteps).toBe(2)
    expect(by.aaaaaaaaaaaa.totalToolCalls).toBe(1)
    expect(by.aaaaaaaaaaaa.runEnds.limits['max-steps']).toBe(1)
    expect(by.bbbbbbbbbbbb.totalSteps).toBe(1)
    expect(by.bbbbbbbbbbbb.totalCost).toBeCloseTo(0.01, 6)
    expect(by.bbbbbbbbbbbb.completedRuns).toBe(1)
    // The costliest row first; the free ones by prompt id, the one with none first.
    expect(s.models.map((r) => r.promptId)).toEqual(['bbbbbbbbbbbb', undefined, 'aaaaaaaaaaaa'])
  })

  it('keeps one row per model when not asked to split, with no prompt id on it', () => {
    const s = buildScorecard([chat()])
    expect(s.models).toHaveLength(1)
    expect(s.models[0].promptId).toBeUndefined()
    expect(s.models[0].totalSteps).toBe(4)
  })
})

describe('messageGroups', () => {
  it("counts a message in the row of the latest reply at or before it, or else the first reply's", () => {
    const msgs = [user(), reply('a', 'p1'), toolTurn('x'), user(), reply('b', 'p2')]
    expect(messageGroups(msgs, 'chat', 'model')).toEqual([
      { model: 'a' },
      { model: 'a' },
      { model: 'a' },
      { model: 'a' },
      { model: 'b' }
    ])
    expect(messageGroups(msgs, 'chat', 'model-prompt').map((k) => k.promptId)).toEqual([
      'p1',
      'p1',
      'p1',
      'p1',
      'p2'
    ])
  })

  it('puts a chat with no reply in its own model, under its own prompt row when split', () => {
    expect(messageGroups([user(), user()], 'chat', 'model')).toEqual([{ model: 'chat' }, { model: 'chat' }])
    expect(messageGroups([user()], 'chat', 'model-prompt')).toEqual([{ model: 'chat', promptId: NO_REPLY_PROMPT_ID }])
  })

  it("credits a run that failed before the first reply to that reply's row, not a model no reply used", () => {
    const messages: ChatMessage[] = [{ ...user(), runEnds: ended({ reason: 'error' }) }, user(), reply('a', 'p1')]
    const byModel = buildScorecard([conv({ model: 'switched-to-later', messages })]).models
    expect(byModel.map((r) => [r.model, r.runEnds.error])).toEqual([['a', 1]])
    const byPrompt = buildScorecard([conv({ model: 'a', messages })], { groupBy: 'model-prompt' }).models
    expect(byPrompt.map((r) => [r.promptId, r.runEnds.error])).toEqual([['p1', 1]])
  })

  it('names an unnamed chat model "unknown"', () => {
    expect(messageGroups([user()], '')).toEqual([{ model: 'unknown' }])
  })
})
