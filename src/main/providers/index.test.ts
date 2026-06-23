import { describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'

/**
 * `createProvider` gates a run on a *usable* key. It must distinguish "no key was
 * ever set" from "a key is stored but can't be decrypted" so the error tells the
 * user whether to enter a key or re-enter the one that silently went stale.
 */

const secrets = vi.hoisted(() => ({ key: null as string | null, stored: false }))

vi.mock('../secrets', () => ({
  getKey: () => secrets.key,
  hasStoredKey: () => secrets.stored
}))

import { createProvider, ProviderError } from './index'

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    models: [],
    requiresKey: true,
    hasKey: false,
    builtIn: true,
    ...overrides
  }
}

describe('createProvider key checks', () => {
  it('throws "No API key set" when nothing is stored', () => {
    secrets.key = null
    secrets.stored = false
    expect(() => createProvider(cfg())).toThrow(ProviderError)
    expect(() => createProvider(cfg())).toThrow('No API key set for Anthropic (Claude).')
  })

  it('throws an unlock-failure message when a key is stored but undecryptable', () => {
    secrets.key = null
    secrets.stored = true
    expect(() => createProvider(cfg())).toThrow(/could not be unlocked/i)
  })

  it('builds a provider when a usable key is present', () => {
    secrets.key = 'sk-test'
    secrets.stored = true
    expect(typeof createProvider(cfg()).streamChat).toBe('function')
  })

  it('does not require a key for local providers', () => {
    secrets.key = null
    secrets.stored = false
    const provider = createProvider(
      cfg({
        id: 'ollama',
        kind: 'openai-compatible',
        label: 'Local — Ollama',
        requiresKey: false,
        baseUrl: 'http://localhost:11434/v1'
      })
    )
    expect(typeof provider.streamChat).toBe('function')
  })
})
