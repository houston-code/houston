import type { Provider } from '@shared/agent'
import type { ModelOption, ProviderConfig } from '@shared/types'
import { providerHeaderScope } from '@shared/types'
import { getKey, getSecretHeaders, hasStoredKey } from '../agentHost'
import { createAnthropicProvider, listAnthropicModels } from './anthropic'
import { createOpenAIProvider, listOpenAIModels } from './openai'
import { createResponsesProvider } from './responses'
import { createGeminiProvider, listGeminiModels } from './gemini'

export class ProviderError extends Error {}

/**
 * Custom headers carry secrets (a gateway bearer token), so their values are stripped
 * from the config before it leaves the main process. Pull the real values from the
 * secrets store here, at request-build time. `undefined` when there are none, so the
 * adapters skip the `defaultHeaders` option entirely.
 */
function resolveHeaders(providerId: string): Record<string, string> | undefined {
  const headers = getSecretHeaders(providerHeaderScope(providerId))
  return Object.keys(headers).length ? headers : undefined
}

/** Build a ready-to-use provider for a configured provider, pulling its key from the secrets store. */
export function createProvider(config: ProviderConfig): Provider {
  const key = getKey(config.id)
  const headers = resolveHeaders(config.id)
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
      return createAnthropicProvider(key ?? '', config.baseUrl, headers)
    case 'openai':
      // Native OpenAI uses the Responses API (GPT-5/o-series path). A custom base
      // URL means a proxy/gateway that may only speak Chat Completions, so fall
      // back to the Chat Completions adapter there.
      return config.baseUrl
        ? createOpenAIProvider(key, config.baseUrl, headers)
        : createResponsesProvider(key)
    case 'openai-compatible':
      return createOpenAIProvider(key, config.baseUrl, headers)
    case 'gemini':
      return createGeminiProvider(key ?? '')
    default:
      throw new ProviderError(`Unknown provider kind: ${config.kind as string}`)
  }
}

/**
 * Fetch the live model list for a provider. OpenAI / OpenAI-compatible hosts may
 * return capability metadata (see `modelOptionFromListing`); Anthropic and Gemini
 * return ids only, so their capabilities come from the name-heuristics in usage.ts.
 */
export async function listModels(config: ProviderConfig): Promise<ModelOption[]> {
  const key = getKey(config.id)
  const headers = resolveHeaders(config.id)
  switch (config.kind) {
    case 'anthropic':
      return (await listAnthropicModels(key ?? '', config.baseUrl, headers)).map((id) => ({
        id
      }))
    case 'openai':
    case 'openai-compatible':
      return listOpenAIModels(key, config.baseUrl, headers)
    case 'gemini':
      return (await listGeminiModels(key ?? '')).map((id) => ({ id }))
    default:
      return []
  }
}
