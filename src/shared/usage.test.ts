import { describe, it, expect } from 'vitest'
import {
  contextPercent,
  contextWindowFor,
  formatTokens,
  formatUsd,
  modelCapabilities,
  modelPricing,
  turnCostUsd
} from './usage'

describe('formatTokens', () => {
  it('shows small counts verbatim', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(1)).toBe('1')
    expect(formatTokens(812)).toBe('812')
    expect(formatTokens(999)).toBe('999')
  })

  it('uses k for thousands and drops trailing .0', () => {
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(12_345)).toBe('12.3k')
    expect(formatTokens(999_999)).toBe('1000k')
  })

  it('uses M for millions', () => {
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })

  it('clamps negative and non-finite inputs to 0', () => {
    expect(formatTokens(-5)).toBe('0')
    expect(formatTokens(NaN)).toBe('0')
    expect(formatTokens(Infinity)).toBe('0')
  })

  it('rounds fractional small counts', () => {
    expect(formatTokens(12.6)).toBe('13')
  })
})

describe('contextWindowFor', () => {
  it('knows the Claude / Gemini / GPT families', () => {
    expect(contextWindowFor('claude-opus-4-8')).toBe(200_000)
    expect(contextWindowFor('gemini-2.5-pro')).toBe(1_000_000)
    expect(contextWindowFor('gpt-4o')).toBe(128_000)
    expect(contextWindowFor('gpt-4o-mini')).toBe(128_000)
    expect(contextWindowFor('gpt-4.1')).toBe(1_000_000)
    expect(contextWindowFor('gpt-3.5-turbo')).toBe(16_385)
  })

  it('matches the o-series reasoning models without false positives', () => {
    expect(contextWindowFor('o3')).toBe(200_000)
    expect(contextWindowFor('o4-mini')).toBe(200_000)
    expect(contextWindowFor('o1-preview')).toBe(200_000)
    expect(contextWindowFor('llama3-8b')).toBeNull() // the "o" in a word must not match
  })

  it('returns null for unknown / local models', () => {
    expect(contextWindowFor('qwen2.5-coder')).toBeNull()
    expect(contextWindowFor('')).toBeNull()
  })
})

describe('contextPercent', () => {
  it('computes a rounded percentage', () => {
    expect(contextPercent(100_000, 200_000)).toBe(50)
    expect(contextPercent(18_000, 200_000)).toBe(9)
  })

  it('clamps to 100 when context exceeds the window', () => {
    expect(contextPercent(250_000, 200_000)).toBe(100)
  })

  it('returns null without a window or usable context', () => {
    expect(contextPercent(5000, null)).toBeNull()
    expect(contextPercent(0, 200_000)).toBeNull()
    expect(contextPercent(NaN, 200_000)).toBeNull()
  })
})

describe('modelPricing', () => {
  it('matches Claude / GPT / Gemini families', () => {
    expect(modelPricing('claude-opus-4-8')).toEqual({ input: 15, output: 75 })
    expect(modelPricing('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 })
    expect(modelPricing('gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6 })
    expect(modelPricing('gemini-2.5-flash')).toEqual({ input: 0.3, output: 2.5 })
    expect(modelPricing('gemini-2.5-pro')).toEqual({ input: 1.25, output: 10 })
  })

  it('returns null for unknown / local models', () => {
    expect(modelPricing('llama-3.1-8b')).toBeNull()
    expect(modelPricing('qwen2.5-coder')).toBeNull()
  })
})

describe('turnCostUsd', () => {
  it('prices input and output tokens per million', () => {
    // 1M in + 1M out on Opus = 15 + 75
    expect(turnCostUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(90, 6)
    // 10k in + 2k out on gpt-4o-mini = 0.0015 + 0.0012
    expect(turnCostUsd('gpt-4o-mini', 10_000, 2_000)).toBeCloseTo(0.0027, 6)
  })

  it('is zero for unknown models or empty token counts', () => {
    expect(turnCostUsd('local-model', 1000, 1000)).toBe(0)
    expect(turnCostUsd('claude-opus-4-8', 0, 0)).toBe(0)
  })
})

describe('formatUsd', () => {
  it('scales precision to the magnitude', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.0042)).toBe('$0.0042')
    expect(formatUsd(0.071)).toBe('$0.071')
    expect(formatUsd(1.234)).toBe('$1.23')
  })
})

describe('modelCapabilities', () => {
  // [model id, vision, reasoning] — one row per family/generation we care about.
  const table: Array<[string, boolean, boolean]> = [
    // Anthropic Claude — multimodal from 3 onward; thinking from 3.7 / 4.x.
    ['claude-opus-4-8', true, true],
    ['claude-sonnet-4-6', true, true],
    ['claude-3-7-sonnet', true, true],
    ['claude-3-7-sonnet-20250219', true, true],
    ['claude-3-5-sonnet-20241022', true, false],
    ['claude-3-haiku-20240307', true, false], // Claude 3 Haiku: vision, no thinking
    ['claude-haiku-4-5', true, true], // 4.x Haiku exposes extended thinking
    ['claude-2.1', false, false], // legacy text-only
    ['claude-instant-1.2', false, false],
    // OpenAI GPT / o-series.
    ['gpt-4o', true, false],
    ['gpt-4o-mini', true, false],
    ['gpt-4.1', true, false],
    ['gpt-5', true, true],
    ['o1-preview', true, true],
    ['o3', true, true],
    ['o4-mini', true, true],
    ['gpt-4-turbo', false, false], // text-only legacy GPT-4
    ['gpt-3.5-turbo', false, false],
    // Google Gemini — multimodal from 1.5; thinking on 2.5.
    ['gemini-2.5-pro', true, true],
    ['gemini-2.5-flash', true, true],
    ['gemini-2.0-flash', true, false],
    ['gemini-1.5-pro', true, false],
    ['gemini-pro', false, false], // 1.0 was text-only
    // Unknown / local models report nothing.
    ['llama-3.1-8b', false, false],
    ['qwen2.5-coder', false, false],
    ['', false, false]
  ]

  it.each(table)('maps %s to vision=%s reasoning=%s', (model, vision, reasoning) => {
    expect(modelCapabilities(model)).toEqual({ vision, reasoning })
  })

  it('does not false-positive the o-series on ordinary words', () => {
    expect(modelCapabilities('llama-3.1-8b').reasoning).toBe(false)
    expect(modelCapabilities('codex').reasoning).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(modelCapabilities('Claude-Opus-4-8')).toEqual({ vision: true, reasoning: true })
    expect(modelCapabilities('GPT-4O')).toEqual({ vision: true, reasoning: false })
  })
})
