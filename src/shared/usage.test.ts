import { describe, it, expect } from 'vitest'
import {
  contextPercent,
  contextWindowFor,
  formatTokens,
  formatUsd,
  modelCapabilities,
  modelPricing,
  resolveCapabilities,
  resolveContextWindow,
  resolvePricing,
  resolveToolSupport,
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
  it('gives 1M-window Claude families their full window and the rest 200K', () => {
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4-8')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-4-7')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(1_000_000)
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000) // Haiku 4.5 stays at 200K
    expect(contextWindowFor('claude-3-5-sonnet-20241022')).toBe(200_000) // older Claude
  })

  it('keeps future Opus/Sonnet minor and major bumps on the 1M window', () => {
    expect(contextWindowFor('claude-opus-4-9')).toBe(1_000_000)
    expect(contextWindowFor('claude-opus-5')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-4-7')).toBe(1_000_000)
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000)
    // But a new Haiku, and Opus/Sonnet at/below 4.5, stay at 200K.
    expect(contextWindowFor('claude-haiku-5')).toBe(200_000)
    expect(contextWindowFor('claude-sonnet-4-5')).toBe(200_000)
  })

  it('knows the Gemini / GPT families', () => {
    expect(contextWindowFor('gemini-2.5-pro')).toBe(1_000_000)
    expect(contextWindowFor('gpt-5')).toBe(400_000)
    expect(contextWindowFor('gpt-5-mini')).toBe(400_000)
    expect(contextWindowFor('gpt-5-nano')).toBe(400_000)
    expect(contextWindowFor('gpt-5.5')).toBe(400_000) // 5.x below 5.6 stay on the GPT-5 window
    expect(contextWindowFor('gpt-5.4')).toBe(400_000)
    // The gpt-5.6 family moved to a 1M window, all tiers plus the bare alias; future
    // 5.x minor bumps stay on it.
    expect(contextWindowFor('gpt-5.6-sol')).toBe(1_000_000)
    expect(contextWindowFor('gpt-5.6-terra')).toBe(1_000_000)
    expect(contextWindowFor('gpt-5.6-luna')).toBe(1_000_000)
    expect(contextWindowFor('gpt-5.6')).toBe(1_000_000)
    expect(contextWindowFor('gpt-5.7')).toBe(1_000_000)
    expect(contextWindowFor('gpt-4o')).toBe(128_000)
    expect(contextWindowFor('gpt-4o-mini')).toBe(128_000)
    expect(contextWindowFor('gpt-4.1')).toBe(1_000_000)
    expect(contextWindowFor('gpt-3.5-turbo')).toBe(16_385)
  })

  it('matches the o-series reasoning models without false positives', () => {
    expect(contextWindowFor('o3')).toBe(200_000)
    expect(contextWindowFor('o4-mini')).toBe(200_000)
    expect(contextWindowFor('o1-preview')).toBe(200_000)
    expect(contextWindowFor('o5')).toBe(200_000) // future o-series isn't pinned to o1/3/4
    expect(contextWindowFor('o5-mini')).toBe(200_000)
    expect(contextWindowFor('llama3-8b')).toBeNull() // the "o" in a word must not match
    expect(contextWindowFor('gpt-4o')).toBe(128_000) // the "o" in 4o isn't the o-series
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
    // Claude families carry no explicit cache prices — they use the fallback
    // multipliers (0.1x read / 1.25x write of the input rate).
    expect(modelPricing('claude-fable-5')).toEqual({ input: 10, output: 50 })
    expect(modelPricing('claude-opus-4-8')).toEqual({ input: 5, output: 25 })
    expect(modelPricing('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 })
    expect(modelPricing('claude-haiku-4-5')).toEqual({ input: 1, output: 5 })
    // OpenAI / Gemini families carry explicit cache rates: discounted reads, free writes.
    expect(modelPricing('gpt-4o-mini')).toEqual({ input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 })
    expect(modelPricing('gemini-2.5-flash')).toEqual({ input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 })
    expect(modelPricing('gemini-2.5-pro')).toEqual({ input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 })
  })

  it('prices the gpt-5.6 codename tiers individually', () => {
    expect(modelPricing('gpt-5.6-sol')).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 })
    expect(modelPricing('gpt-5.6-terra')).toEqual({ input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 })
    expect(modelPricing('gpt-5.6-luna')).toEqual({ input: 1, output: 6, cacheRead: 0.1, cacheWrite: 0 })
    // The bare alias routes to sol; earlier 5.x keep the flat family rate.
    expect(modelPricing('gpt-5.6')).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 })
    expect(modelPricing('gpt-5.5')).toEqual({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 })
  })

  it('returns null for unknown / local models', () => {
    expect(modelPricing('llama-3.1-8b')).toBeNull()
    expect(modelPricing('qwen2.5-coder')).toBeNull()
  })
})

describe('turnCostUsd', () => {
  it('prices input and output tokens per million', () => {
    // 1M in + 1M out on Opus = 5 + 25
    expect(turnCostUsd('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30, 6)
    // 10k in + 2k out on gpt-4o-mini = 0.0015 + 0.0012
    expect(turnCostUsd('gpt-4o-mini', 10_000, 2_000)).toBeCloseTo(0.0027, 6)
  })

  it('is zero for unknown models or empty token counts', () => {
    expect(turnCostUsd('local-model', 1000, 1000)).toBe(0)
    expect(turnCostUsd('claude-opus-4-8', 0, 0)).toBe(0)
  })

  it('prices cache reads at 0.1x and cache writes at 1.25x the input rate', () => {
    // 1M input on Opus ($5/M): all fresh = $5; all cache-read = $0.50; all cache-write = $6.25.
    expect(turnCostUsd('claude-opus-4-8', 1_000_000, 0)).toBeCloseTo(5, 6)
    expect(
      turnCostUsd('claude-opus-4-8', 1_000_000, 0, { readTokens: 1_000_000 })
    ).toBeCloseTo(0.5, 6)
    expect(
      turnCostUsd('claude-opus-4-8', 1_000_000, 0, { writeTokens: 1_000_000 })
    ).toBeCloseTo(6.25, 6)
  })

  it('uses the family cache rates on OpenAI / Gemini: discounted reads, free writes', () => {
    // gpt-4o reads at its listed $1.25/M (0.5x input), NOT the Anthropic 0.1x fallback.
    expect(turnCostUsd('gpt-4o', 1_000_000, 0, { readTokens: 1_000_000 })).toBeCloseTo(1.25, 6)
    // gpt-5 reads at $0.125/M (0.1x input).
    expect(turnCostUsd('gpt-5', 1_000_000, 0, { readTokens: 1_000_000 })).toBeCloseTo(0.125, 6)
    // Gemini flash reads at $0.075/M (0.25x input).
    expect(
      turnCostUsd('gemini-2.5-flash', 1_000_000, 0, { readTokens: 1_000_000 })
    ).toBeCloseTo(0.075, 6)
    // Cache writes are free on these families — the explicit 0 must not fall back
    // to Anthropic's 1.25x surcharge.
    expect(turnCostUsd('gpt-4o', 1_000_000, 0, { writeTokens: 1_000_000 })).toBeCloseTo(0, 6)
    expect(
      turnCostUsd('gemini-2.5-flash', 1_000_000, 0, { writeTokens: 1_000_000 })
    ).toBeCloseTo(0, 6)
  })

  it('charges only the fresh remainder at full input rate (cache-heavy loop)', () => {
    // 100k input where 90k is a cache read, 5k a cache write, 5k fresh — plus 2k output.
    // 5k*5 + 90k*0.5 + 5k*6.25 + 2k*25, all per-million.
    const expected =
      (5_000 * 5 + 90_000 * 0.5 + 5_000 * 6.25 + 2_000 * 25) / 1_000_000
    expect(
      turnCostUsd('claude-opus-4-8', 100_000, 2_000, { readTokens: 90_000, writeTokens: 5_000 })
    ).toBeCloseTo(expected, 6)
    // The caching-aware figure is far below the flat estimate for the same tokens.
    expect(expected).toBeLessThan(turnCostUsd('claude-opus-4-8', 100_000, 2_000))
  })

  it('prices a host-routed model from its listed caps (no heuristic match)', () => {
    // deepseek via a rich host: the name-heuristics return null, so without caps
    // this model costs $0; the listed prices make it real.
    const caps = { inputPrice: 0.5, outputPrice: 2, cacheReadPrice: 0.05, cacheWritePrice: 0 }
    expect(turnCostUsd('deepseek/deepseek-r1', 1_000_000, 1_000_000)).toBe(0)
    expect(turnCostUsd('deepseek/deepseek-r1', 1_000_000, 1_000_000, undefined, caps)).toBeCloseTo(2.5, 6)
    expect(
      turnCostUsd('deepseek/deepseek-r1', 1_000_000, 0, { readTokens: 1_000_000 }, caps)
    ).toBeCloseTo(0.05, 6)
    // Listed free cache writes must not fall back to the 1.25x surcharge.
    expect(
      turnCostUsd('deepseek/deepseek-r1', 1_000_000, 0, { writeTokens: 1_000_000 }, caps)
    ).toBeCloseTo(0, 6)
  })

  it('never lets the cache split exceed the total input (clamps parts to the whole)', () => {
    // Bogus counts where read+write > input must not produce a negative fresh cost.
    const cost = turnCostUsd('claude-opus-4-8', 1_000, 0, {
      readTokens: 10_000,
      writeTokens: 10_000
    })
    expect(cost).toBeGreaterThanOrEqual(0)
    // Whole input treated as cache read (0.1x): 1000 * 5 * 0.1 / 1e6.
    expect(cost).toBeCloseTo((1_000 * 5 * 0.1) / 1_000_000, 6)
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
    // Anthropic Claude — multimodal from 3 onward; thinking from 3.7 / 4.x / Fable.
    ['claude-fable-5', true, true],
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
    // Google Gemini — multimodal from 1.5; thinking on 2.5 and the 3.x line.
    ['gemini-2.5-pro', true, true],
    ['gemini-2.5-flash', true, true],
    ['gemini-2.0-flash', true, false],
    ['gemini-1.5-pro', true, false],
    ['gemini-pro', false, false], // 1.0 was text-only
    // Gemini 3.x: the old `2\.`-only vision pattern reported these as text-only, and the
    // 2.5-only reasoning mirror reported them as non-reasoning. Both are wrong, and these
    // are shipped defaults — mirrors geminiSupportsThinking in providers/reasoning.ts.
    ['gemini-3.5-flash', true, true],
    ['gemini-3.1-flash-lite', true, true],
    ['gemini-3.1-pro-preview', true, true],
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

describe('resolvePricing', () => {
  it('prefers listed prices over the family heuristic, per-field', () => {
    // A host-routed Claude: listed input/output win; the family heuristic still
    // supplies nothing for cache here (Claude uses the multiplier fallback), so
    // only the listed cache prices appear.
    const p = resolvePricing('anthropic/claude-sonnet-5', {
      inputPrice: 2.8,
      outputPrice: 14,
      cacheReadPrice: 0.28,
      cacheWritePrice: 3.5
    })
    expect(p).toEqual({ input: 2.8, output: 14, cacheRead: 0.28, cacheWrite: 3.5 })
  })

  it('falls back per-field to the heuristic when a listing is partial', () => {
    // Listed input only: output comes from the sonnet family heuristic.
    expect(resolvePricing('claude-sonnet-4-6', { inputPrice: 2.8 })).toMatchObject({
      input: 2.8,
      output: 15
    })
  })

  it('resolves a host-only model entirely from caps, and null without them', () => {
    expect(resolvePricing('deepseek/deepseek-r1', { inputPrice: 0.5, outputPrice: 2 })).toEqual({
      input: 0.5,
      output: 2
    })
    expect(resolvePricing('deepseek/deepseek-r1')).toBeNull()
    // A price for only one side can't make a usable pricing.
    expect(resolvePricing('deepseek/deepseek-r1', { inputPrice: 0.5 })).toBeNull()
  })

  it('keeps listed zero prices (free routes cost nothing, not heuristic rates)', () => {
    expect(resolvePricing('meta-llama/llama-3.3-70b:free', { inputPrice: 0, outputPrice: 0 })).toEqual({
      input: 0,
      output: 0
    })
  })
})

describe('resolveCapabilities', () => {
  it('prefers listed caps over the name heuristic', () => {
    // gpt-4o heuristically has vision but no reasoning; listed caps override both.
    expect(resolveCapabilities('gpt-4o', { vision: false, reasoning: true })).toEqual({
      vision: false,
      reasoning: true
    })
  })

  it('falls back per-field when a cap is absent', () => {
    // Only reasoning is listed; vision still comes from the gpt-4o heuristic (true).
    expect(resolveCapabilities('gpt-4o', { reasoning: true })).toEqual({
      vision: true,
      reasoning: true
    })
  })

  it('uses heuristics entirely when no caps are given', () => {
    expect(resolveCapabilities('claude-opus-4-8')).toEqual({ vision: true, reasoning: true })
  })

  it('lights up a host-routed id the heuristics do not recognize', () => {
    // deepseek-r1 matches no curated family, so heuristics report all-false; the
    // host's listed reasoning flag is what surfaces it.
    expect(resolveCapabilities('deepseek/deepseek-r1', { reasoning: true })).toEqual({
      vision: false,
      reasoning: true
    })
  })
})

describe('resolveToolSupport', () => {
  it('returns the listed value when known', () => {
    expect(resolveToolSupport({ tools: true })).toBe(true)
    expect(resolveToolSupport({ tools: false })).toBe(false)
  })

  it('returns null (unknown) when unlisted — no name heuristic', () => {
    expect(resolveToolSupport({})).toBeNull()
    expect(resolveToolSupport(undefined)).toBeNull()
  })
})

describe('resolveContextWindow', () => {
  it('prefers a listed context window', () => {
    expect(resolveContextWindow('gpt-4o', { contextWindow: 64_000 })).toBe(64_000)
  })

  it('falls back to the family heuristic when unlisted', () => {
    expect(resolveContextWindow('gpt-4o')).toBe(contextWindowFor('gpt-4o'))
  })

  it('returns null for an unknown id with no listed window', () => {
    expect(resolveContextWindow('deepseek/deepseek-r1')).toBeNull()
  })
})
