import { describe, expect, it } from 'vitest'
import { resolveModelArg } from './modelArg'
import type { AppSettings, ProviderConfig } from './types'

const provider = (id: string, models: string[]): ProviderConfig => ({
  id,
  kind: id === 'openrouter' ? 'openai-compatible' : (id as ProviderConfig['kind']),
  label: id,
  models: models.map((m) => ({ id: m })),
  requiresKey: true,
  hasKey: true,
  builtIn: id !== 'openrouter'
})

const settings = {
  providers: [
    provider('anthropic', ['claude-sonnet-5']),
    provider('openai', ['gpt-5']),
    provider('openrouter', ['deepseek/deepseek-r1', 'openai/gpt-oss-120b', 'anthropic/claude-sonnet-5'])
  ]
} as unknown as AppSettings

describe('resolveModelArg with aggregator ids that contain a slash', () => {
  it('resolves an aggregator id whose prefix is not a provider to the provider that lists it', () => {
    expect(resolveModelArg('deepseek/deepseek-r1', settings)).toEqual({
      providerId: 'openrouter',
      model: 'deepseek/deepseek-r1'
    })
  })

  it('prefers an exact listed id over a provider prefix whose provider does not list the rest', () => {
    expect(resolveModelArg('openai/gpt-oss-120b', settings)).toEqual({
      providerId: 'openrouter',
      model: 'openai/gpt-oss-120b'
    })
  })

  it('keeps provider/model for a model the provider lists, and for one nobody lists', () => {
    expect(resolveModelArg('anthropic/claude-sonnet-5', settings)).toEqual({
      providerId: 'anthropic',
      model: 'claude-sonnet-5'
    })
    expect(resolveModelArg('openai/ft-my-model', settings)).toEqual({ providerId: 'openai', model: 'ft-my-model' })
  })

  it('reaches an aggregator id through its provider prefix', () => {
    expect(resolveModelArg('openrouter/anthropic/claude-sonnet-5', settings)).toEqual({
      providerId: 'openrouter',
      model: 'anthropic/claude-sonnet-5'
    })
  })

  it('still returns null for a slash id nobody lists under an unknown prefix', () => {
    expect(resolveModelArg('mistral/large', settings)).toBeNull()
  })
})
