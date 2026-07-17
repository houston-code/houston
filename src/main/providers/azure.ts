import type { Provider } from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { DEFAULT_AZURE_API_VERSION } from '@shared/provider-catalog'
import { createChatCompletionsProvider, type ChatCompletionsClient } from './openai'

/**
 * GPT models on Azure OpenAI.
 *
 * `AzureOpenAI` extends `OpenAI`, so — like bedrock.ts/vertex.ts on the Claude side —
 * this file only *constructs* a client: every wire concern (streaming, tool calls,
 * the usage split) belongs to the shared Chat Completions adapter. See
 * `createChatCompletionsProvider` in openai.ts.
 *
 * What Azure changes is addressing and auth, neither of which a base URL can express:
 * the key rides an `api-key` header rather than `Authorization: Bearer`, the REST API
 * version is a required query parameter, and a model is reached at
 * `/openai/deployments/{deployment}` under the resource's own endpoint.
 *
 * Deployments are named by whoever created them, so Houston treats **a model id as a
 * deployment name** and lets the SDK route each request to its own deployment (it
 * reads the request's `model` when the client pins no `deployment`). Pinning one on
 * the client would send every model in the provider's list to a single deployment,
 * which is why this deliberately doesn't. It also means there is nothing to enumerate
 * — see {@link listAzureOpenAIModels}.
 */

export interface AzureOpenAIOptions {
  /** Azure OpenAI API key, sent as `api-key`. Required: the SDK has no other auth here. */
  apiKey?: string
  /** Resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  endpoint?: string
  /** REST API version. Defaults to {@link DEFAULT_AZURE_API_VERSION}. */
  apiVersion?: string
  /** Explicit base URL, for a gateway fronting the resource. Wins over `endpoint`. */
  baseUrl?: string
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
}

/**
 * Resolve the endpoint Houston should address, honouring the SDK's own env fallback
 * so a provider already configured through the environment keeps working.
 */
export function azureEndpoint(endpoint?: string): string | undefined {
  return endpoint || process.env.AZURE_OPENAI_ENDPOINT || undefined
}

/**
 * The base URL to hand the SDK, derived the same way `AzureOpenAI` derives it
 * internally (`{endpoint}/openai`, with the deployment appended per request).
 *
 * Houston derives it rather than passing `endpoint` through because the SDK resolves
 * `baseURL` from `OPENAI_BASE_URL` as a *default parameter* and then rejects
 * `endpoint` alongside it — so on a machine with `OPENAI_BASE_URL` exported (the
 * ordinary way to point the OpenAI SDK at a proxy), passing `endpoint` throws
 * "baseURL and endpoint are mutually exclusive", an error naming two things the user
 * never set. Passing an explicit `baseURL` suppresses that default and settles the
 * address here, where Houston's own config is the only input. Exported for testing.
 */
export function azureBaseUrl(opts: AzureOpenAIOptions): string | undefined {
  if (opts.baseUrl) return opts.baseUrl
  const endpoint = azureEndpoint(opts.endpoint)
  return endpoint ? `${endpoint.replace(/\/+$/, '')}/openai` : undefined
}

/** A provider for GPT models on Azure OpenAI. */
export function createAzureOpenAIProvider(opts: AzureOpenAIOptions = {}): Provider {
  // Lazy + memoized like the other adapters: the SDK is imported on first turn.
  let clientPromise: Promise<ChatCompletionsClient> | undefined
  const getClient = (): Promise<ChatCompletionsClient> =>
    (clientPromise ??= import('openai').then(
      (m) =>
        new m.AzureOpenAI({
          apiKey: opts.apiKey,
          apiVersion: opts.apiVersion || DEFAULT_AZURE_API_VERSION,
          // Always explicit (see azureBaseUrl); `endpoint` is deliberately not passed.
          baseURL: azureBaseUrl(opts),
          ...(opts.headers && Object.keys(opts.headers).length
            ? { defaultHeaders: opts.headers }
            : {})
        })
    ))

  return createChatCompletionsProvider(getClient)
}

/**
 * Azure OpenAI's model list: whatever the user configured, unchanged.
 *
 * Unlike every other host there is nothing to fetch *or* curate. Azure serves models
 * as deployments the user names themselves, so the list can't be predicted (no
 * curated list would match anyone's resource) and the Models API the OpenAI adapter
 * uses isn't reachable on this path. Echoing the configured models keeps Fetch honest:
 * it neither invents ids nor wipes the ones the user typed, where returning [] would
 * make a working resource look like it serves nothing.
 */
export function listAzureOpenAIModels(models: ModelOption[]): ModelOption[] {
  return models.map((m) => ({ ...m }))
}
