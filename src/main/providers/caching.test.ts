import { describe, it, expect } from 'vitest'
import { needsExplicitCacheControl, promptCacheKeyFor } from './caching'

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

describe('promptCacheKeyFor', () => {
  it('is stable for one conversation and differs between conversations', () => {
    expect(promptCacheKeyFor('conv-1')).toBe(promptCacheKeyFor('conv-1'))
    expect(promptCacheKeyFor('conv-1')).not.toBe(promptCacheKeyFor('conv-2'))
  })

  it("gives each subagent dispatch a bucket of its own, apart from the conversation's", () => {
    const parent = promptCacheKeyFor('conv-1')
    const a = promptCacheKeyFor('conv-1', 'call-a')
    expect(a).toBe(promptCacheKeyFor('conv-1', 'call-a'))
    expect(new Set([parent, a, promptCacheKeyFor('conv-1', 'call-b')]).size).toBe(3)
    // Parts are kept apart, so ('a', 'bc') and ('ab', 'c') never collide.
    expect(promptCacheKeyFor('a', 'bc')).not.toBe(promptCacheKeyFor('ab', 'c'))
  })

  it('is a short hash that carries nothing of the id it was made from', () => {
    const id = '3f2b9c1e-7a44-4b1d-9a0e-5c6d7e8f9a0b'
    const key = promptCacheKeyFor(id, 'toolu_01ABC')
    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(key).not.toContain(id.slice(0, 8))
    expect(key).not.toContain('toolu')
  })
})
