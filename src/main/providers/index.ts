import type { Provider } from '@shared/agent'
import type { ProviderConfig } from '@shared/types'
import { getKey, hasStoredKey } from '../secrets'
import { createAnthropicProvider, listAnthropicModels } from './anthropic'
import { createOpenAIProvider, listOpenAIModels } from './openai'
import { createGeminiProvider, listGeminiModels } from './gemini'

export class ProviderError extends Error {}

/** Build a ready-to-use provider for a configured provider, pulling its key from the secrets store. */
export function createProvider(config: ProviderConfig): Provider {
  const key = getKey(config.id)
  if (config.requiresKey && !key) {
    // A key can be stored yet unreadable — e.g. the OS Keychain entry can no longer
    // be unlocked after an app re-sign/update. Tell those two cases apart so the user
    // knows to re-enter the key rather than thinking nothing was ever configured.
    throw new ProviderError(
      hasStoredKey(config.id)
        ? `The saved API key for ${config.label} could not be unlocked. Re-enter it in Settings.`
        : `No API key set for ${config.label}.`
    )
  }

  switch (config.kind) {
    case 'anthropic':
      return createAnthropicProvider(key ?? '', config.baseUrl)
    case 'openai':
      return createOpenAIProvider(key, config.baseUrl)
    case 'openai-compatible':
      return createOpenAIProvider(key, config.baseUrl)
    case 'gemini':
      return createGeminiProvider(key ?? '')
    default:
      throw new ProviderError(`Unknown provider kind: ${config.kind as string}`)
  }
}

/** Fetch the live model list for a provider. */
export async function listModels(config: ProviderConfig): Promise<string[]> {
  const key = getKey(config.id)
  switch (config.kind) {
    case 'anthropic':
      return listAnthropicModels(key ?? '', config.baseUrl)
    case 'openai':
    case 'openai-compatible':
      return listOpenAIModels(key, config.baseUrl)
    case 'gemini':
      return listGeminiModels(key ?? '')
    default:
      return []
  }
}
