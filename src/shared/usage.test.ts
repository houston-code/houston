import { describe, it, expect } from 'vitest'
import {
  contextPercent,
  contextWindowFor,
  formatTokens,
  formatUsd,
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
