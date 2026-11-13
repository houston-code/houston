import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '@shared/agent'
import { meterOnEvent, meterText, meterTokens, startMeter } from './runMeter'

const text = (delta: string): AgentEvent => ({ runId: 'r', type: 'text', delta })
const usage = (outputTokens: number): AgentEvent => ({
  runId: 'r',
  type: 'usage',
  inputTokens: 1000,
  outputTokens,
  cost: 0
})

describe('run meter', () => {
  it('shows only the clock until any output arrives', () => {
    const m = startMeter(1_000)
    expect(meterTokens(m)).toBe(0)
    expect(meterText(m, 5_400)).toBe('4s')
  })

  it('estimates the streaming round from its characters', () => {
    let m = startMeter(0)
    m = meterOnEvent(m, text('a'.repeat(400)))
    m = meterOnEvent(m, { runId: 'r', type: 'reasoning', delta: 'b'.repeat(400) })
    expect(meterTokens(m)).toBe(200)
    expect(meterText(m, 12_000)).toBe('12s · 200 tokens')
  })

  it("replaces the estimate with the provider's count when the round ends", () => {
    let m = startMeter(0)
    m = meterOnEvent(m, text('a'.repeat(400)))
    m = meterOnEvent(m, usage(5000), 130)
    expect(meterTokens(m)).toBe(130)
    // The next round's estimate adds on top of what was reported.
    m = meterOnEvent(m, text('a'.repeat(40)))
    expect(meterTokens(m)).toBe(140)
    m = meterOnEvent(m, usage(5200), 70)
    expect(meterTokens(m)).toBe(200)
    expect(meterText(m, 65_000)).toBe('1m 5s · 200 tokens')
  })

  it('takes back text the loop retracted for a retry', () => {
    let m = startMeter(0)
    m = meterOnEvent(m, text('a'.repeat(800)))
    m = meterOnEvent(m, {
      runId: 'r',
      type: 'turn_discarded',
      attempt: 1,
      reason: 'overloaded',
      textChars: 800,
      reasoningChars: 0
    })
    expect(meterTokens(m)).toBe(0)
  })

  it('ignores a negative delta and unrelated events', () => {
    const m = startMeter(0)
    expect(meterOnEvent(m, usage(10), -50).reported).toBe(0)
    expect(meterOnEvent(m, { runId: 'r', type: 'notice', message: 'x' })).toBe(m)
  })

  it('says "1 token" in the singular', () => {
    expect(meterText({ startedAt: 0, reported: 1, streamedChars: 0 }, 0)).toBe('0s · 1 token')
  })
})
