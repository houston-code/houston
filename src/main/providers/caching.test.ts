import { describe, it, expect } from 'vitest'
import { needsExplicitCacheControl } from './caching'

describe('needsExplicitCacheControl', () => {
  it('is false without listing metadata (hand-typed ids, plain servers)', () => {
    // The nonstandard field must never reach a server that didn't advertise
    // cache billing — strict OpenAI-compatible servers can reject unknown shapes.
    expect(needsExplicitCacheControl('anthropic/claude-sonnet-5')).toBe(false)
    expect(needsExplicitCacheControl('anthropic/claude-sonnet-5', {})).toBe(false)
  })

  it('is false when the host lists no cache-write price (route does not bill explicit writes)', () => {
    expect(
      needsExplicitCacheControl('anthropic/claude-sonnet-5', { cacheReadPrice: 0.3 })
    ).toBe(false)
    expect(
      needsExplicitCacheControl('anthropic/claude-sonnet-5', { cacheWritePrice: 0 })
    ).toBe(false)
  })

  it('is true for explicit-caching families with a listed write price', () => {
    const caps = { cacheWritePrice: 3.75 }
    expect(needsExplicitCacheControl('anthropic/claude-sonnet-5', caps)).toBe(true)
    expect(needsExplicitCacheControl('qwen/qwen3-coder', caps)).toBe(true)
    expect(needsExplicitCacheControl('google/gemini-2.5-pro', caps)).toBe(true)
  })

  it('is false for automatic-caching upstreams even when a write price is listed', () => {
    // Hosts list cache pricing for OpenAI-family models too, but those cache
    // automatically — breakpoints there are pure noise.
    const caps = { cacheWritePrice: 1.25 }
    expect(needsExplicitCacheControl('openai/gpt-5.6-luna-pro', caps)).toBe(false)
    expect(needsExplicitCacheControl('deepseek/deepseek-r1', caps)).toBe(false)
    expect(needsExplicitCacheControl('x-ai/grok-4', caps)).toBe(false)
  })
})
