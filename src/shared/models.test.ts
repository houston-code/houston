import { describe, expect, it } from 'vitest'
import type { ModelOption } from './types'
import { modelDisplayName, naturalCompare, pickDefaultModel, sortedModels } from './models'

const ids = (ms: ModelOption[]): string[] => ms.map((m) => m.id)
const m = (...xs: string[]): ModelOption[] => xs.map((id) => ({ id }))

describe('naturalCompare', () => {
  it('orders numeric segments by value, not lexically', () => {
    expect(['v10', 'v2'].sort(naturalCompare)).toEqual(['v2', 'v10'])
  })
})

describe('modelDisplayName', () => {
  it('dotifies the trailing version of an Anthropic id (claude-model-x.y)', () => {
    expect(modelDisplayName('anthropic', 'claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(modelDisplayName('anthropic', 'claude-sonnet-4-6')).toBe('claude-sonnet-4.6')
    expect(modelDisplayName('anthropic', 'claude-haiku-4-5')).toBe('claude-haiku-4.5')
  })

  it('leaves an Anthropic id with no minor version unchanged', () => {
    expect(modelDisplayName('anthropic', 'claude-fable-5')).toBe('claude-fable-5')
    expect(modelDisplayName('anthropic', 'claude-sonnet-5')).toBe('claude-sonnet-5')
  })

  it('drops a trailing release-date suffix from an Anthropic id', () => {
    expect(modelDisplayName('anthropic', 'claude-opus-4-1-20260101')).toBe('claude-opus-4.1')
    expect(modelDisplayName('anthropic', 'claude-opus-4-8-20260514')).toBe('claude-opus-4.8')
  })

  it('handles legacy version-first Anthropic ids too', () => {
    expect(modelDisplayName('anthropic', 'claude-3-5-sonnet')).toBe('claude-3.5-sonnet')
  })

  it('produces the same name whether the id was seeded or fetched (no mismatch)', () => {
    // The crux: a curated id and the raw id a live Fetch returns normalize identically.
    expect(modelDisplayName('anthropic', 'claude-opus-4-6')).toBe('claude-opus-4.6')
  })

  it("strips Bedrock's vendor prefix", () => {
    expect(modelDisplayName('bedrock', 'anthropic.claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(modelDisplayName('bedrock', 'anthropic.claude-haiku-4-5')).toBe('claude-haiku-4.5')
  })

  it("normalizes Vertex's @-dated snapshots", () => {
    expect(modelDisplayName('vertex', 'claude-opus-4-5@20251101')).toBe('claude-opus-4.5')
    expect(modelDisplayName('vertex', 'claude-sonnet-4@20250514')).toBe('claude-sonnet-4')
    expect(modelDisplayName('vertex', 'claude-opus-4-8')).toBe('claude-opus-4.8')
  })

  it('names one model identically whichever host serves it', () => {
    // The point of stripping host addressing: the picker shouldn't read like three
    // different models when Anthropic, Bedrock and Vertex all serve Opus 4.8.
    const first = modelDisplayName('anthropic', 'claude-opus-4-8')
    expect(modelDisplayName('bedrock', 'anthropic.claude-opus-4-8')).toBe(first)
    expect(modelDisplayName('vertex', 'claude-opus-4-8@20260101')).toBe(first)
  })

  it('returns other providers ids unchanged (already the fetched form)', () => {
    expect(modelDisplayName('openai', 'gpt-5.1')).toBe('gpt-5.1')
    expect(modelDisplayName('openai', 'gpt-5-mini')).toBe('gpt-5-mini')
    expect(modelDisplayName('openai', 'o4-mini')).toBe('o4-mini')
    expect(modelDisplayName('gemini', 'gemini-2.5-pro')).toBe('gemini-2.5-pro')
    expect(modelDisplayName('openai-compatible', 'llama3.1:latest')).toBe('llama3.1:latest')
  })
})

describe('sortedModels', () => {
  it('groups a family together and orders it newest-version first (Opus 4.8 before 4.7)', () => {
    // Stored as the curated defaults are: opus split around sonnet/haiku.
    const stored = m('claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-4-7')
    expect(ids(sortedModels('anthropic', stored))).toEqual([
      'claude-opus-4-8',
      'claude-opus-4-7', // grouped with its family, newest first
      'claude-sonnet-4-6',
      'claude-haiku-4-5'
    ])
  })

  it('ranks the Fable flagship family ahead of Opus/Sonnet/Haiku', () => {
    const stored = m('claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5', 'claude-sonnet-4-6')
    expect(ids(sortedModels('anthropic', stored))).toEqual([
      'claude-fable-5', // newest flagship family leads
      'claude-opus-4-8',
      'claude-sonnet-4-6',
      'claude-haiku-4-5'
    ])
  })

  it('orders OpenAI families most-advanced first, with sizes and o-series version-descending', () => {
    const stored = m('gpt-4o', 'gpt-4o-mini', 'o3', 'o4-mini', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano')
    expect(ids(sortedModels('openai', stored))).toEqual([
      'gpt-5',
      'gpt-5-mini',
      'gpt-5-nano', // base < mini < nano within the family
      'gpt-4o',
      'gpt-4o-mini',
      'o4-mini', // o-series after the GPT-4 line, newest (o4) before o3
      'o3'
    ])
  })

  it('treats GPT minor versions like Claude — grouped in the GPT-5 family, newest first', () => {
    // gpt-5.5 / gpt-5.4 are minor bumps of GPT-5 (analogous to Opus 4.8 / 4.7), so they
    // stay in the GPT-5 family and sort by version.
    const stored = m('gpt-5', 'gpt-5.5', 'gpt-5.4', 'gpt-5-mini', 'gpt-5.5-mini')
    expect(ids(sortedModels('openai', stored))).toEqual([
      'gpt-5.5',
      'gpt-5.5-mini', // same version (5.5), base before mini
      'gpt-5.4',
      'gpt-5',
      'gpt-5-mini'
    ])
  })

  it('orders the gpt-5.6 codename tiers flagship-first (sol < terra < luna)', () => {
    // The codenames replace mini/nano; without tier ranking they would sort
    // alphabetically (luna, sol, terra) and bury the flagship.
    const stored = m('gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4')
    expect(ids(sortedModels('openai', stored))).toEqual([
      'gpt-5.6-sol', // flagship of the newest family
      'gpt-5.6-terra', // mid tier
      'gpt-5.6-luna', // efficient tier
      'gpt-5.5',
      'gpt-5.4'
    ])
  })

  it('keeps Gemini tiers grouped (pro before flash) and newest version first', () => {
    const stored = m('gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite')
    expect(ids(sortedModels('gemini', stored))).toEqual([
      'gemini-2.5-pro', // pro tier leads
      // then the flash family, newest version first; within a version, base before lite.
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash'
    ])
  })

  it('does not treat the "mini" inside "gemini" as a size', () => {
    // If "mini" matched, gemini-2.5-pro would rank as a small size and sort oddly.
    const stored = m('gemini-2.5-flash', 'gemini-2.5-pro')
    expect(ids(sortedModels('gemini', stored))).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
  })

  it('sorts unrecognized models after known families, grouped by stem, newest first', () => {
    const stored = m('llama-2', 'gpt-5', 'qwen-2.5', 'llama-3')
    expect(ids(sortedModels('openai-compatible', stored))).toEqual([
      'gpt-5', // known family first
      'llama-3', // llama grouped, newest version first
      'llama-2',
      'qwen-2.5'
    ])
  })

  it('groups local-model families together rather than interleaving by version', () => {
    const stored = m('qwen-2.5', 'llama-3.1', 'qwen-3', 'llama-2')
    // llama family (3.1, 2) then qwen family (3, 2.5) — families contiguous, not
    // interleaved by version across families.
    expect(ids(sortedModels('openai-compatible', stored))).toEqual([
      'llama-3.1',
      'llama-2',
      'qwen-3',
      'qwen-2.5'
    ])
  })

  it('does not mutate the input array', () => {
    const stored = m('o4-mini', 'gpt-5')
    const before = ids(stored)
    sortedModels('openai', stored)
    expect(ids(stored)).toEqual(before)
  })

  it('falls back to the label for ordering when ids tie', () => {
    const stored: ModelOption[] = [
      { id: 'x', label: 'Banana' },
      { id: 'x', label: 'Apple' }
    ]
    expect(sortedModels('openai-compatible', stored).map((o) => o.label)).toEqual(['Apple', 'Banana'])
  })
})

describe('pickDefaultModel', () => {
  it('honors defaultModel when it is still in the list', () => {
    expect(
      pickDefaultModel({ kind: 'openai', defaultModel: 'gpt-5.5', models: m('gpt-5.6-sol', 'gpt-5.5') })
    ).toBe('gpt-5.5')
  })

  it('ignores a dangling defaultModel that was removed from the list', () => {
    expect(
      pickDefaultModel({ kind: 'openai', defaultModel: 'gone', models: m('gpt-5.5') })
    ).toBe('gpt-5.5')
  })

  it('picks by capability order, not stored order (the aggregator-login case)', () => {
    // A live-fetched aggregator list arrives in the provider's own order (often
    // newest-created first), putting an efficiency-tier variant at models[0]. The
    // pick must not hand a fresh login that arbitrary head — it takes the flagship
    // by the display ordering instead.
    const fetched = m('openai/gpt-5.6-luna-pro', 'openai/gpt-5.6-luna', 'openai/gpt-5.6-sol')
    expect(pickDefaultModel({ kind: 'openai-compatible', models: fetched })).toBe(
      'openai/gpt-5.6-sol'
    )
  })

  it('returns null when the provider has no models', () => {
    expect(pickDefaultModel({ kind: 'openai-compatible', models: [] })).toBeNull()
  })
})
