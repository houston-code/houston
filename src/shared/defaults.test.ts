import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from './types'
import {
  DEFAULT_SHELL_OUTPUT_MAX_BYTES,
  backfillDefaultModels,
  defaultProviders,
  defaultSettings,
  reconcileSelectedModel,
  resolveShellOutputBudget,
  stripBuiltInModelLabels
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

  it('seeds the current GPT-5.x line on the OpenAI provider and defaults to gpt-5.6-sol', () => {
    const openai = defaultSettings().providers.find((p) => p.id === 'openai')!
    expect(openai.models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])
    )
    // Deprecated ids are not seeded on a fresh install.
    expect(openai.models.map((m) => m.id)).not.toContain('gpt-5')
    expect(openai.defaultModel).toBe('gpt-5.6-sol')
  })

  it('seeds claude-fable-5 on the Anthropic provider', () => {
    const anthropic = defaultSettings().providers.find((p) => p.id === 'anthropic')!
    expect(anthropic.models.map((m) => m.id)).toContain('claude-fable-5')
  })

  it('seeds built-in models as ids only, with no hardcoded display label', () => {
    // Display names are derived from the id (see modelDisplayName), so no seeded label
    // can drift out of sync with what a live Fetch returns.
    for (const p of defaultSettings().providers) {
      for (const model of p.models) {
        expect(model.label).toBeUndefined()
      }
    }
  })
})

describe('stripBuiltInModelLabels', () => {
  it('removes labels from built-in providers but keeps custom-endpoint labels', () => {
    const stripped = stripBuiltInModelLabels([
      provider({
        id: 'anthropic',
        kind: 'anthropic',
        builtIn: true,
        models: [
          { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
          { id: 'claude-haiku-4-5', label: 'claude-haiku-4.5' }
        ]
      }),
      provider({
        id: 'my-proxy',
        kind: 'openai-compatible',
        builtIn: false,
        models: [{ id: 'house-model', label: 'House Model' }]
      })
    ])
    expect(stripped[0].models).toEqual([{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }])
    // A user's custom endpoint keeps whatever label they configured.
    expect(stripped[1].models).toEqual([{ id: 'house-model', label: 'House Model' }])
  })

  it('is referentially stable for a provider that has no labels to strip', () => {
    const p = provider({ id: 'openai', builtIn: true, models: [{ id: 'gpt-5.1' }] })
    const out = stripBuiltInModelLabels([p])
    expect(out[0]).toBe(p)
  })
})

describe('backfillDefaultModels', () => {
  it('appends new built-in default models a saved provider is missing', () => {
    const saved = [provider({ id: 'openai', models: [{ id: 'gpt-4o', label: 'GPT-4o' }] })]
    const ids = backfillDefaultModels(saved)[0].models.map((m) => m.id)
    // The pre-existing model stays first; new defaults (incl. gpt-5.6-sol) are appended.
    expect(ids[0]).toBe('gpt-4o')
    expect(ids).toContain('gpt-5.6-sol')
    // No duplicate of the model the user already had.
    expect(ids.filter((id) => id === 'gpt-4o')).toHaveLength(1)
  })

  it('preserves user ordering of existing models', () => {
    const saved = [provider({ id: 'openai', models: [{ id: 'o4-mini' }, { id: 'gpt-4o-mini' }] })]
    const ids = backfillDefaultModels(saved)[0].models.map((m) => m.id)
    expect(ids.slice(0, 2)).toEqual(['o4-mini', 'gpt-4o-mini'])
  })

  it('does not duplicate a default model the user already has', () => {
    const saved = [provider({ id: 'openai', models: [{ id: 'gpt-5.6-sol' }] })]
    const ids = backfillDefaultModels(saved)[0].models.map((m) => m.id)
    expect(ids.filter((id) => id === 'gpt-5.6-sol')).toHaveLength(1)
  })

  it('with onlyIds, appends just those ids and leaves other missing defaults out', () => {
    // The v3-style scoped call: seed Fable without re-adding other Claude defaults the
    // user has since deleted.
    const saved = [
      provider({ id: 'anthropic', kind: 'anthropic', models: [{ id: 'claude-opus-4-8' }] })
    ]
    const models = backfillDefaultModels(saved, ['claude-fable-5'])[0].models
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-fable-5'])
    // The appended model is id-only; its display name is derived, not seeded.
    expect(models.find((m) => m.id === 'claude-fable-5')).toEqual({ id: 'claude-fable-5' })
  })

  it('with onlyIds, does not re-add an already-present scoped id', () => {
    const saved = [
      provider({ id: 'anthropic', kind: 'anthropic', models: [{ id: 'claude-fable-5' }] })
    ]
    const ids = backfillDefaultModels(saved, ['claude-fable-5'])[0].models.map((m) => m.id)
    expect(ids).toEqual(['claude-fable-5'])
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

describe('reconcileSelectedModel', () => {
  const providers = [
    provider({
      id: 'anthropic',
      kind: 'anthropic',
      defaultModel: 'claude-opus-4-8',
      models: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }]
    }),
    provider({ id: 'openai', kind: 'openai', models: [{ id: 'gpt-5.6-sol' }] })
  ]

  it('leaves a null selection null (initial default is the caller’s job)', () => {
    expect(reconcileSelectedModel(providers, null)).toBeNull()
  })

  it('keeps a selection that still resolves to a real provider + model', () => {
    const sel = { providerId: 'anthropic', model: 'claude-haiku-4-5' }
    expect(reconcileSelectedModel(providers, sel)).toBe(sel)
  })

  it('re-points to the provider default when the selected model was removed', () => {
    // The user deletes claude-haiku-4-5 while it was selected; the provider survives.
    const sel = { providerId: 'anthropic', model: 'claude-haiku-4-5-removed' }
    expect(reconcileSelectedModel(providers, sel)).toEqual({
      providerId: 'anthropic',
      model: 'claude-opus-4-8'
    })
  })

  it('re-points to the first model when the provider default was itself removed', () => {
    const withRemovedDefault = [
      provider({
        id: 'anthropic',
        kind: 'anthropic',
        defaultModel: 'claude-opus-4-8-removed',
        models: [{ id: 'claude-haiku-4-5' }]
      })
    ]
    const sel = { providerId: 'anthropic', model: 'gone' }
    expect(reconcileSelectedModel(withRemovedDefault, sel)).toEqual({
      providerId: 'anthropic',
      model: 'claude-haiku-4-5'
    })
  })

  it('clears the selection when its provider was removed entirely', () => {
    const sel = { providerId: 'deleted-provider', model: 'whatever' }
    expect(reconcileSelectedModel(providers, sel)).toBeNull()
  })

  it('clears the selection when the provider survives but has no models left', () => {
    const emptied = [provider({ id: 'anthropic', kind: 'anthropic', models: [] })]
    const sel = { providerId: 'anthropic', model: 'claude-opus-4-8' }
    expect(reconcileSelectedModel(emptied, sel)).toBeNull()
  })
})
