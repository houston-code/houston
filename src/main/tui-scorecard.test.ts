import { describe, expect, it } from 'vitest'
import { buildScorecard } from '@shared/scorecard'
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
})
