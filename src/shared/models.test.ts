import { describe, expect, it } from 'vitest'
import type { ModelOption } from './types'
import { naturalCompare, sortedModels } from './models'

const ids = (ms: ModelOption[]): string[] => ms.map((m) => m.id)
const m = (...xs: string[]): ModelOption[] => xs.map((id) => ({ id }))

describe('naturalCompare', () => {
  it('orders numeric segments by value, not lexically', () => {
    expect(['v10', 'v2'].sort(naturalCompare)).toEqual(['v2', 'v10'])
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

  it('puts a future GPT generation at the top, grouped and version-descending', () => {
    // gpt-6/gpt-7 aren't in the family table by name; the gpt-next catch-all keeps
    // them ahead of gpt-5 instead of dropping them to the unknown bucket.
    const stored = m('gpt-5', 'gpt-4o', 'gpt-6', 'gpt-7')
    expect(ids(sortedModels('openai', stored))).toEqual(['gpt-7', 'gpt-6', 'gpt-5', 'gpt-4o'])
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
