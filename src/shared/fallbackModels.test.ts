import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderConfig } from './types'
import { addFallback, fallbackRows, moveFallback, removeFallback } from './fallbackModels'

const providers = [
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude-haiku-5-5' }] },
  { id: 'openai', label: 'OpenAI', kind: 'openai', requiresKey: true, hasKey: false, models: [{ id: 'gpt-5', label: 'GPT 5' }] }
] as unknown as ProviderConfig[]
const s = (fallbackModels: AppSettings['fallbackModels']) => ({ providers, fallbackModels })

describe('fallbackRows', () => {
  it('names each entry and marks the ones a run would skip', () => {
    const rows = fallbackRows(
      s([
        { providerId: 'openai', model: 'gpt-5' },
        { providerId: 'anthropic', model: 'claude-haiku-5-5' },
        { providerId: 'gone', model: 'm' }
      ])
    )
    expect(rows.map((r) => r.label)).toEqual(['OpenAI: GPT 5', expect.stringMatching(/^Anthropic: /), 'gone/m'])
    expect(rows.map((r) => r.skipped)).toEqual(['no API key', undefined, 'provider removed'])
  })

  it('is empty with no list', () => {
    expect(fallbackRows(s(undefined))).toEqual([])
  })
})

describe('editing the chain', () => {
  const a = { providerId: 'anthropic', model: 'claude-haiku-5-5' }
  const b = { providerId: 'openai', model: 'gpt-5' }
  const c = { providerId: 'x', model: 'y' }

  it('adds at the end, never twice', () => {
    expect(addFallback(undefined, a)).toEqual([a])
    expect(addFallback([a], b)).toEqual([a, b])
    expect(addFallback([a, b], { ...b })).toEqual({ error: 'that model is already in the list' })
  })

  it('removes and moves, clamped to the ends', () => {
    expect(removeFallback([a, b, c], 1)).toEqual([a, c])
    expect(removeFallback([a], 5)).toEqual([a])
    expect(moveFallback([a, b, c], 2, -1)).toEqual([a, c, b])
    expect(moveFallback([a, b, c], 0, -1)).toEqual([a, b, c])
    expect(moveFallback([a, b, c], 0, 1)).toEqual([b, a, c])
    expect(moveFallback([a, b], 9, 1)).toEqual([a, b])
  })
})
