import { describe, it, expect } from 'vitest'
import {
  anthropicThinking,
  anthropicSupportsThinking,
  openaiReasoningEffort,
  openaiSupportsReasoning,
  geminiThinkingBudget,
  geminiSupportsThinking,
  ANTHROPIC_REPLY_HEADROOM
} from './reasoning'

describe('anthropic thinking', () => {
  it('is null when off', () => {
    expect(anthropicThinking('claude-opus-4-8', 'off')).toBeNull()
    expect(anthropicThinking('claude-opus-4-8', undefined)).toBeNull()
  })

  it('gates on model support', () => {
    expect(anthropicSupportsThinking('claude-opus-4-8')).toBe(true)
    expect(anthropicSupportsThinking('claude-sonnet-4-6')).toBe(true)
    expect(anthropicSupportsThinking('claude-haiku-4-5')).toBe(true)
    expect(anthropicSupportsThinking('claude-3-5-sonnet')).toBe(false)
    expect(anthropicThinking('claude-3-5-sonnet', 'high')).toBeNull()
  })

  it('returns budget < max_tokens', () => {
    const t = anthropicThinking('claude-opus-4-8', 'high')
    expect(t).not.toBeNull()
    expect(t!.budgetTokens).toBeGreaterThanOrEqual(1024)
    expect(t!.maxTokens).toBe(t!.budgetTokens + ANTHROPIC_REPLY_HEADROOM)
    expect(t!.maxTokens).toBeGreaterThan(t!.budgetTokens)
  })

  it('scales budget with effort', () => {
    const low = anthropicThinking('claude-opus-4-8', 'low')!.budgetTokens
    const high = anthropicThinking('claude-opus-4-8', 'high')!.budgetTokens
    expect(high).toBeGreaterThan(low)
  })
})

describe('openai reasoning_effort', () => {
  it('only for reasoning models', () => {
    expect(openaiSupportsReasoning('o3')).toBe(true)
    expect(openaiSupportsReasoning('o4-mini')).toBe(true)
    expect(openaiSupportsReasoning('gpt-5')).toBe(true)
    expect(openaiSupportsReasoning('gpt-4o')).toBe(false)
    expect(openaiReasoningEffort('gpt-4o', 'high')).toBeUndefined()
    expect(openaiReasoningEffort('o3', 'medium')).toBe('medium')
    expect(openaiReasoningEffort('o3', 'off')).toBeUndefined()
  })
})

describe('gemini thinking budget', () => {
  it('only for 2.5 models', () => {
    expect(geminiSupportsThinking('gemini-2.5-pro')).toBe(true)
    expect(geminiSupportsThinking('gemini-2.0-flash')).toBe(false)
    expect(geminiThinkingBudget('gemini-2.0-flash', 'high')).toBeUndefined()
    expect(geminiThinkingBudget('gemini-2.5-flash', 'low')).toBeGreaterThan(0)
    expect(geminiThinkingBudget('gemini-2.5-pro', 'off')).toBeUndefined()
  })
})
