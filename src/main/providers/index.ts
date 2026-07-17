import type { Provider } from '@shared/agent'
import type { ModelOption, ProviderConfig } from '@shared/types'
import { providerHeaderScope } from '@shared/types'
import { assertNever } from '@shared/assert'
import { getKey, getSecretHeaders, hasStoredKey } from '../agentHost'
import { createAnthropicProvider, listAnthropicModels } from './anthropic'
import { createOpenAIProvider, listOpenAIModels } from './openai'
import { createResponsesProvider } from './responses'
import { createGeminiProvider, listGeminiModels } from './gemini'
import { createBedrockProvider, listBedrockModels } from './bedrock'
import { createVertexProvider, listVertexModels } from './vertex'

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

/**
 * Region preflight for the cloud-hosted Claude kinds, which build their endpoint from
 * a region and can't address a host without one. Their SDKs do raise this themselves,
 * but in terms of constructor options ("the client should be instantiated with the
 * `region` option") — not something a Houston user can act on. Fail here instead,
 * naming the setting and the env var they can. Mirrors the missing-key preflight in
 * {@link createProvider}.
 *
 * `envVars` are the SDK's own fallbacks, checked so a provider that already works
 * from the environment isn't rejected for leaving the field blank. `baseUrlExempts`
 * covers Bedrock, where an explicit endpoint replaces the region-derived one; Vertex
 * needs its region regardless, since that also goes in the request path.
 */
function requireRegion(config: ProviderConfig, envVars: string[], baseUrlExempts: boolean): void {
  if (config.region) return
  if (baseUrlExempts && config.baseUrl) return
  if (envVars.some((v) => process.env[v])) return
  throw new ProviderError(
    `No region set for ${config.label}. Set one in Settings, or export ${envVars[0]}.`
  )
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
    case 'bedrock':
      requireRegion(config, ['AWS_REGION', 'AWS_DEFAULT_REGION'], true)
      // The key is optional here: pass it as the bearer token when the user stored
      // one, otherwise the client signs with the AWS credential chain.
      return createBedrockProvider({
        region: config.region,
        apiKey: key ?? undefined,
        baseUrl: config.baseUrl,
        headers
      })
    case 'vertex':
      requireRegion(config, ['CLOUD_ML_REGION'], false)
      // No key of any kind: Vertex authenticates with Google ADC.
      return createVertexProvider({
        region: config.region,
        projectId: config.projectId,
        baseUrl: config.baseUrl,
        headers
      })
    default:
      // Exhaustive: a new ProviderKind is a compile error here, rather than a
      // provider that throws "unknown kind" only once someone selects it.
      return assertNever(config.kind, 'createProvider')
  }
}

/**
 * Fetch the live model list for a provider. OpenAI / OpenAI-compatible hosts may
 * return capability metadata (see `modelOptionFromListing`), and Gemini reports
 * each model's context window (`inputTokenLimit`); Anthropic returns ids only,
 * so its capabilities come from the name-heuristics in usage.ts.
 *
 * Bedrock and Vertex have no Models API to fetch from, so they answer from a curated
 * list. That keeps Fetch meaningful (it restores the known ids after an edit) while
 * never reaching the network.
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
      return listGeminiModels(key ?? '')
    case 'bedrock':
      return listBedrockModels()
    case 'vertex':
      return listVertexModels()
    default:
      // Exhaustive: a new kind must decide how it lists models, rather than silently
      // returning [] and looking like a host that serves nothing.
      return assertNever(config.kind, 'listModels')
  }
}
