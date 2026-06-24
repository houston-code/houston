import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from './types'
import {
  DEFAULT_SHELL_OUTPUT_MAX_BYTES,
  backfillDefaultModels,
  defaultProviders,
  defaultSettings,
  resolveShellOutputBudget
} from './defaults'

function provider(over: Partial<ProviderConfig> & Pick<ProviderConfig, 'id'>): ProviderConfig {
  return {
    kind: 'openai',
    label: 'test',
    models: [],
    requiresKey: true,
    hasKey: false,
    builtIn: true,
    ...over
  }
}

describe('resolveShellOutputBudget', () => {
  it('uses the default when unset', () => {
    expect(resolveShellOutputBudget({})).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
  })

  it('honours a positive override', () => {
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: 8000 })).toBe(8000)
  })

  it('floors a fractional override', () => {
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: 8000.9 })).toBe(8000)
  })

  it('falls back to the default for 0 or negative (which would truncate everything)', () => {
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: 0 })).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
    expect(resolveShellOutputBudget({ shellOutputMaxBytes: -5 })).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
  })
})

describe('defaultSettings', () => {
  it('seeds the shell-output budget', () => {
    expect(defaultSettings().shellOutputMaxBytes).toBe(DEFAULT_SHELL_OUTPUT_MAX_BYTES)
  })

  it('seeds the GPT-5 family on the OpenAI provider and defaults to gpt-5', () => {
    const openai = defaultSettings().providers.find((p) => p.id === 'openai')!
    expect(openai.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5', 'gpt-5-mini', 'gpt-5-nano'])
    )
    expect(openai.defaultModel).toBe('gpt-5')
  })
})

describe('backfillDefaultModels', () => {
  it('appends new built-in default models a saved provider is missing', () => {
    const saved = [provider({ id: 'openai', models: [{ id: 'gpt-4o', label: 'GPT-4o' }] })]
    const ids = backfillDefaultModels(saved)[0].models.map((m) => m.id)
    // The pre-existing model stays first; new defaults (incl. GPT-5) are appended.
    expect(ids[0]).toBe('gpt-4o')
    expect(ids).toContain('gpt-5')
    // No duplicate of the model the user already had.
    expect(ids.filter((id) => id === 'gpt-4o')).toHaveLength(1)
  })

  it('preserves user ordering of existing models', () => {
    const saved = [provider({ id: 'openai', models: [{ id: 'o4-mini' }, { id: 'gpt-4o-mini' }] })]
    const ids = backfillDefaultModels(saved)[0].models.map((m) => m.id)
    expect(ids.slice(0, 2)).toEqual(['o4-mini', 'gpt-4o-mini'])
  })

  it('does not duplicate a default model the user already has', () => {
    const saved = [provider({ id: 'openai', models: [{ id: 'gpt-5' }] })]
    const ids = backfillDefaultModels(saved)[0].models.map((m) => m.id)
    expect(ids.filter((id) => id === 'gpt-5')).toHaveLength(1)
  })

  it('leaves custom (non-built-in) providers untouched', () => {
    const custom = provider({
      id: 'my-proxy',
      kind: 'openai-compatible',
      builtIn: false,
      models: [{ id: 'some-local-model' }]
    })
    expect(backfillDefaultModels([custom])[0].models).toEqual([{ id: 'some-local-model' }])
  })

  it('leaves the empty local-provider lists empty', () => {
    const ollama = defaultProviders().find((p) => p.id === 'ollama')!
    expect(backfillDefaultModels([{ ...ollama, models: [] }])[0].models).toEqual([])
  })

  it('is a no-op when the saved list already matches the defaults', () => {
    const saved = defaultProviders()
    expect(backfillDefaultModels(saved)).toEqual(saved)
  })
})
