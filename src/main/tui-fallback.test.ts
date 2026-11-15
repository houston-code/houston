import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { resolveModelArg } from '@shared/modelArg'
import { fallbackChange, parseFallbackArgs, renderFallbacks } from './tui-fallback'
import type { Painter } from './tui'

const plain: Painter = (t) => t
const providers = [
  { id: 'anthropic', label: 'Anthropic', kind: 'anthropic', requiresKey: true, hasKey: true, models: [{ id: 'claude-haiku-5-5' }] },
  { id: 'openai', label: 'OpenAI', kind: 'openai', requiresKey: true, hasKey: true, models: [{ id: 'gpt-5' }] }
] as unknown as ProviderConfig[]
const settings = (fallbackModels?: AppSettings['fallbackModels']): AppSettings =>
  ({ schemaVersion: 1, providers, selected: null, fallbackModels }) as unknown as AppSettings

describe('parseFallbackArgs', () => {
  it('reads each verb, 1-based numbers, and refuses anything else', () => {
    expect(parseFallbackArgs('')).toEqual({ op: 'list' })
    expect(parseFallbackArgs('list')).toEqual({ op: 'list' })
    expect(parseFallbackArgs('add openai/gpt-5')).toEqual({ op: 'add', model: 'openai/gpt-5' })
    expect(parseFallbackArgs('rm 2')).toEqual({ op: 'remove', index: 1 })
    expect(parseFallbackArgs('up 3')).toEqual({ op: 'up', index: 2 })
    expect(parseFallbackArgs('down 1')).toEqual({ op: 'down', index: 0 })
    for (const bad of ['add', 'add a b', 'remove', 'remove 0', 'remove x', 'swap 1', 'list 2']) {
      expect(parseFallbackArgs(bad), bad).toEqual({ op: 'usage' })
    }
  })
})

describe('fallbackChange', () => {
  const resolve = (s: AppSettings) => (typed: string) => resolveModelArg(typed, s)

  it('adds a model by id or provider/id, and refuses an unknown or repeated one', () => {
    const s0 = settings()
    const r = fallbackChange({ op: 'add', model: 'gpt-5' }, s0, resolve(s0))
    expect(r).toEqual({ list: [{ providerId: 'openai', model: 'gpt-5' }], message: '· fallback 1: openai/gpt-5' })
    const s1 = settings([{ providerId: 'openai', model: 'gpt-5' }])
    expect('error' in fallbackChange({ op: 'add', model: 'openai/gpt-5' }, s1, resolve(s1))).toBe(true)
    const unknown = fallbackChange({ op: 'add', model: 'nope\x1b[2J' }, s1, resolve(s1))
    expect('error' in unknown && unknown.error).toContain('no model "nope[2J"')
  })

  it('removes and reorders by number', () => {
    const s = settings([
      { providerId: 'openai', model: 'gpt-5' },
      { providerId: 'anthropic', model: 'claude-haiku-5-5' }
    ])
    const up = fallbackChange({ op: 'up', index: 1 }, s, resolve(s))
    expect('list' in up && up.list[0].providerId).toBe('anthropic')
    expect('message' in up && up.message).toContain('is now fallback 1')
    const rm = fallbackChange({ op: 'remove', index: 0 }, s, resolve(s))
    expect('list' in rm && rm.list).toEqual([{ providerId: 'anthropic', model: 'claude-haiku-5-5' }])
    expect('error' in fallbackChange({ op: 'remove', index: 4 }, s, resolve(s))).toBe(true)
  })
})

describe('renderFallbacks', () => {
  it('numbers the chain and says how to add one when empty', () => {
    expect(renderFallbacks(settings(), plain)).toContain('/model fallback add <model>')
    const out = renderFallbacks(settings([{ providerId: 'gone', model: 'x' }]), plain)
    expect(out).toContain('1. gone/x')
    expect(out).toContain('skipped: provider removed')
  })
})
