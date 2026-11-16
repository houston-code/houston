import { describe, expect, it } from 'vitest'
import { buildScorecard } from '@shared/scorecard'
import { attachFailureSignals, buildFailureSignals } from '@shared/failureSignals'
import type { ChatMessage } from '@shared/agent'
import { renderScorecard, SCORECARD_TOP_TOOLS } from './tui-scorecard'
import type { Painter } from './tui'

const plain: Painter = (t) => t

describe('renderScorecard', () => {
  it('says so when there are no runs', () => {
    expect(renderScorecard(buildScorecard([]), plain)).toContain('no runs yet')
  })

  it('shows what the desktop scorecard shows for each model', () => {
    const tools = Array.from({ length: SCORECARD_TOP_TOOLS + 2 }, (_, i) => `tool_${i}`)
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: tools.map((name, i) => ({ id: `c${i}`, name, args: {} })) },
      ...tools.map((name, i) => ({ role: 'tool', content: 'ok', toolCallId: `c${i}`, toolName: name })),
      { role: 'assistant', content: 'done' }
    ] as unknown as ChatMessage[]
    const card = buildScorecard([
      { model: 'claude-haiku-5-5', messages, usage: { inputTokens: 10, outputTokens: 12_000, cost: 0.5 } },
      { model: 'local\x1b[2J', messages: [{ role: 'user', content: 'hi' }] as ChatMessage[], errored: true }
    ])
    const out = renderScorecard(card, plain)
    expect(out).toContain('Loop scorecard  2 runs')
    expect(out).toContain('claude-haiku-5-5  1 run')
    expect(out).toMatch(/avg steps [\d.]+ · avg tools [\d.]+/)
    expect(out).toContain('clean finish 100% (1 of 1)')
    expect(out).toContain('output 12')
    expect(out).toContain('+2 more')
    expect(out).toContain('cost –')
    expect(out).not.toContain('\x1b')
  })

  it('says how runs stopped short and which failure signals fired, and that it reads the chats', () => {
    const at = '2026-11-01T00:00:00.000Z'
    const messages = [
      { role: 'user', content: 'go', runEnds: [{ reason: 'error', message: 'down', at }] },
      { role: 'assistant', content: '', model: 'm', toolCalls: [{ id: 'c0', name: 'multi_edit', arguments: {} }] },
      { role: 'tool', content: 'Error: edits must be a non-empty array.', toolCallId: 'c0', toolName: 'multi_edit' },
      { role: 'assistant', content: 'Halfway.', model: 'm', runEnds: [{ reason: 'limit', limit: 'max-steps', at }] }
    ] as ChatMessage[]
    const input = [{ model: 'm', messages }]
    const card = attachFailureSignals(buildScorecard(input), buildFailureSignals(input))
    const out = renderScorecard(card, plain)
    expect(out).toContain('stopped short: failed 1, step limit 1')
    // The step limit is listed once, with the stops, not again as a signal.
    expect(out).toContain('signals: no reply 1, malformed tool calls 1')
    expect(out).toContain('reading the chats, text included; only counts are shown')
    expect(out).not.toContain('by prompt version')
  })

  it('says when no signal fired, and leaves the line out when none were attached', () => {
    const input = [{ model: 'm', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] as ChatMessage[] }]
    expect(renderScorecard(attachFailureSignals(buildScorecard(input), buildFailureSignals(input)), plain)).toContain(
      'signals: none'
    )
    const bare = renderScorecard(buildScorecard(input), plain)
    expect(bare).not.toContain('signals:')
    expect(bare).not.toContain('stopped short')
  })

  it('shows no finish rate, rather than 0%, for a model no chat’s latest run was on', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'first', model: 'model-a' },
      { role: 'user', content: 'switch' },
      { role: 'assistant', content: 'second', model: 'model-b' }
    ] as ChatMessage[]
    const out = renderScorecard(buildScorecard([{ model: 'model-b', messages }]), plain)
    const block = (model: string): string => out.split('\n\n').find((b) => b.includes(`${model}  `)) ?? ''
    expect(block('model-a')).toContain('clean finish – (no latest run here)')
    expect(block('model-a')).not.toContain('0%')
    expect(block('model-b')).toContain('clean finish 100% (1 of 1)')
  })

  it('names the row of chats with no reply yet when split by prompt version', () => {
    const at = '2026-11-01T00:00:00.000Z'
    const input = [{ model: 'm', messages: [{ role: 'user', content: 'go', runEnds: [{ reason: 'error', at }] }] as ChatMessage[] }]
    const card = attachFailureSignals(buildScorecard(input, { groupBy: 'model-prompt' }), buildFailureSignals(input, { groupBy: 'model-prompt' }))
    const out = renderScorecard(card, plain)
    expect(out).toContain('m  no reply yet  1 run')
    expect(out).not.toContain('before prompt ids')
  })

  it('names each row’s prompt version when split by one', () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'old', model: 'm' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'new', model: 'm', promptId: '0123456789ab\x1b[2J' }
    ] as ChatMessage[]
    const out = renderScorecard(buildScorecard([{ model: 'm', messages }], { groupBy: 'model-prompt' }), plain)
    expect(out).toContain('· by prompt version')
    expect(out).toContain('m  prompt 0123456789ab[2J  1 run')
    expect(out).toContain('m  before prompt ids  1 run')
    expect(out).not.toContain('\x1b')
  })
})
