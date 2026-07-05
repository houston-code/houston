import { describe, it, expect } from 'vitest'
import {
  anthropicThinking,
  anthropicSupportsThinking,
  anthropicSupportsInterleavedThinking,
  openaiReasoningEffort,
  openaiResponsesReasoning,
  openaiSupportsReasoning,
  geminiThinkingBudget,
  geminiSupportsThinking,
  ANTHROPIC_REPLY_HEADROOM
} from './reasoning'

describe('anthropic thinking', () => {
  it('is null when off or unsupported', () => {
    expect(anthropicThinking('claude-opus-4-8', 'off')).toBeNull()
    expect(anthropicThinking('claude-opus-4-8', undefined)).toBeNull()
    expect(anthropicThinking('claude-3-5-sonnet', 'high')).toBeNull()
  })

  it('gates on model support', () => {
    expect(anthropicSupportsThinking('claude-fable-5')).toBe(true)
    expect(anthropicSupportsThinking('claude-opus-4-8')).toBe(true)
    expect(anthropicSupportsThinking('claude-sonnet-4-6')).toBe(true)
    expect(anthropicSupportsThinking('claude-haiku-4-5')).toBe(true)
    expect(anthropicSupportsThinking('claude-3-5-sonnet')).toBe(false)
  })

  it('routes Fable through adaptive thinking with the xhigh tier', () => {
    // Fable has no legacy budget shape and does expose xhigh, like Opus 4.7/4.8.
    expect(anthropicThinking('claude-fable-5', 'high')).toMatchObject({
      kind: 'adaptive',
      effort: 'high',
      display: 'summarized'
    })
    expect(anthropicThinking('claude-fable-5', 'xhigh')).toMatchObject({ effort: 'xhigh' })
  })

  // Opus 4.7/4.8 (and Fable/Mythos) 400 on the legacy enabled+budget_tokens shape;
  // they must use adaptive thinking + effort. This is the regression we're fixing.
  it('uses adaptive thinking + effort on 4.6+ models, never budget_tokens', () => {
    for (const model of [
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-6'
    ]) {
      const t = anthropicThinking(model, 'high')
      expect(t).toMatchObject({ kind: 'adaptive', effort: 'high', display: 'summarized' })
      expect(t).not.toHaveProperty('budgetTokens')
    }
  })

  it('passes xhigh through on Opus 4.7+ but clamps it to high on 4.6', () => {
    expect(anthropicThinking('claude-opus-4-8', 'xhigh')).toMatchObject({ effort: 'xhigh' })
    expect(anthropicThinking('claude-opus-4-7', 'xhigh')).toMatchObject({ effort: 'xhigh' })
    expect(anthropicThinking('claude-sonnet-4-6', 'xhigh')).toMatchObject({ effort: 'high' })
    expect(anthropicThinking('claude-opus-4-6', 'xhigh')).toMatchObject({ effort: 'high' })
  })

  it('uses legacy budget thinking on pre-4.6 models and Haiku 4.5', () => {
    for (const model of [
      'claude-3-7-sonnet-20250219',
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-opus-4-1-20250805',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5'
    ]) {
      const t = anthropicThinking(model, 'high')
      expect(t?.kind).toBe('budget')
    }
  })

  it('flags interleaved thinking on legacy Claude 4 Opus/Sonnet, not on 3.7 or Haiku 4.5', () => {
    // Supported: the 4.x Opus/Sonnet legacy line takes the interleaved beta.
    for (const model of [
      'claude-opus-4-20250514',
      'claude-sonnet-4-20250514',
      'claude-opus-4-1-20250805',
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929'
    ]) {
      expect(anthropicSupportsInterleavedThinking(model)).toBe(true)
      expect(anthropicThinking(model, 'high')).toMatchObject({ kind: 'budget', interleaved: true })
    }
    // Unsupported legacy models: header would be rejected (3.7) or ignored (Haiku 4.5).
    for (const model of ['claude-3-7-sonnet-20250219', 'claude-haiku-4-5']) {
      expect(anthropicSupportsInterleavedThinking(model)).toBe(false)
      expect(anthropicThinking(model, 'high')).toMatchObject({ kind: 'budget', interleaved: false })
    }
    // Adaptive models never carry the flag (they interleave automatically).
    expect(anthropicSupportsInterleavedThinking('claude-opus-4-8')).toBe(false)
  })

  it('keeps budget < max_tokens on the legacy path', () => {
    const t = anthropicThinking('claude-haiku-4-5', 'high')
    expect(t?.kind).toBe('budget')
    if (t?.kind === 'budget') {
      expect(t.budgetTokens).toBeGreaterThanOrEqual(1024)
      expect(t.maxTokens).toBe(t.budgetTokens + ANTHROPIC_REPLY_HEADROOM)
      expect(t.maxTokens).toBeGreaterThan(t.budgetTokens)
    }
  })

  it('scales max_tokens sizing with effort', () => {
    const low = anthropicThinking('claude-opus-4-8', 'low')!
    const high = anthropicThinking('claude-opus-4-8', 'high')!
    expect(high.maxTokens).toBeGreaterThan(low.maxTokens)
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

  it('clamps xhigh to high for the Chat Completions path', () => {
    expect(openaiReasoningEffort('gpt-5', 'xhigh')).toBe('high')
  })

  it('honors a host-listed capability over the id heuristic', () => {
    // A host-routed reasoning model the regex doesn't recognize still gets an effort.
    expect(openaiReasoningEffort('deepseek/deepseek-r1', 'high')).toBeUndefined()
    expect(openaiReasoningEffort('deepseek/deepseek-r1', 'high', true)).toBe('high')
    // An explicit false suppresses it even for a model the heuristic would match.
    expect(openaiReasoningEffort('gpt-5', 'medium', false)).toBeUndefined()
    // Still gated on effort being on.
    expect(openaiReasoningEffort('deepseek/deepseek-r1', 'off', true)).toBeUndefined()
  })
})

describe('openai Responses reasoning', () => {
  it('passes xhigh through and defaults summary to auto', () => {
    expect(openaiResponsesReasoning('gpt-5.1', 'xhigh')).toEqual({ effort: 'xhigh', summary: 'auto' })
  })

  it('honors an explicit summary mode and omits it when none', () => {
    expect(openaiResponsesReasoning('o3', 'high', 'detailed')).toEqual({ effort: 'high', summary: 'detailed' })
    expect(openaiResponsesReasoning('o3', 'high', 'none')).toEqual({ effort: 'high' })
  })

  it('is undefined when off or unsupported', () => {
    expect(openaiResponsesReasoning('gpt-5', 'off')).toBeUndefined()
    expect(openaiResponsesReasoning('gpt-4o', 'high')).toBeUndefined()
  })
})

describe('xhigh clamping for providers without an xhigh tier', () => {
  // Opus 4.7+ has an xhigh tier (covered in the anthropic describe). Sonnet 4.6
  // and the 4.6 line do not, so xhigh must collapse onto high there.
  it('anthropic clamps xhigh to high on models without an xhigh tier', () => {
    const high = anthropicThinking('claude-sonnet-4-6', 'high')!
    const xhigh = anthropicThinking('claude-sonnet-4-6', 'xhigh')!
    expect(xhigh).toEqual(high)
  })

  it('gemini clamps xhigh to its high budget', () => {
    expect(geminiThinkingBudget('gemini-2.5-pro', 'xhigh')).toBe(
      geminiThinkingBudget('gemini-2.5-pro', 'high')
    )
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
