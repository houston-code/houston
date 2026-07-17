import type { Provider } from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { FOUNDRY_MODELS } from '@shared/provider-catalog'
import { createMessagesProvider, type MessagesClient } from './anthropic'

/**
 * Claude on Microsoft Foundry.
 *
 * Like bedrock.ts and vertex.ts, this only constructs a client: `AnthropicFoundry`
 * extends `Anthropic`, so the shared adapter in anthropic.ts handles every wire
 * concern. See `createMessagesProvider`.
 *
 * Foundry is the key-based member of the hosted-Claude set — Bedrock signs with the
 * AWS chain and Vertex uses Google ADC, but here the user's Foundry key rides the
 * usual `x-api-key` header against their own resource's endpoint. So unlike its two
 * siblings this kind does require a key; what it borrows from them is the shape,
 * not the credential story.
 *
 * Keeping the address Houston's own takes one explicit step — see {@link NO_ENV_RESOURCE}.
 */

/**
 * Suppress the SDK's environment fallback for the resource name.
 *
 * `AnthropicFoundry` resolves `resource` from `ANTHROPIC_FOUNDRY_RESOURCE` as a
 * *default parameter*, then rejects a `baseURL` passed alongside it
 * ("baseURL and resource are mutually exclusive"). Since Houston always settles the
 * address itself and passes an explicit `baseURL` (so that `ANTHROPIC_FOUNDRY_BASE_URL`
 * — resolved the same way — can't silently redirect a configured provider either),
 * an exported `ANTHROPIC_FOUNDRY_RESOURCE` would otherwise make every run fail with
 * an error naming two options the user never touched.
 *
 * An empty string is the fix, for the same reason `apiKey: null` is in vertex.ts: the
 * default parameter only fires on `undefined`, so any defined value stops it, and ''
 * is falsy enough to skip the mutual-exclusion check below it.
 */
const NO_ENV_RESOURCE = { resource: '' }

export interface FoundryOptions {
  /** Foundry API key, sent as `x-api-key`. Required: Houston configures no other auth here. */
  apiKey?: string
  /** Resource name, e.g. `my-resource`. The SDK's `ANTHROPIC_FOUNDRY_RESOURCE` fallback is honored. */
  resource?: string
  /** Explicit base URL, for a gateway fronting the resource. Wins over `resource`. */
  baseUrl?: string
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
}

/**
 * The base URL to hand the SDK, derived exactly as `AnthropicFoundry` derives it from
 * a resource name. Houston resolves the `ANTHROPIC_FOUNDRY_RESOURCE` fallback itself
 * so the value survives {@link NO_ENV_RESOURCE}. Exported for testing.
 */
export function foundryBaseUrl(opts: FoundryOptions): string | undefined {
  if (opts.baseUrl) return opts.baseUrl
  const resource = opts.resource || process.env.ANTHROPIC_FOUNDRY_RESOURCE
  return resource ? `https://${resource}.services.ai.azure.com/anthropic/` : undefined
}

/** A provider for Claude on Microsoft Foundry. */
export function createFoundryProvider(opts: FoundryOptions = {}): Provider {
  // Lazy + memoized, like the other adapters.
  let clientPromise: Promise<MessagesClient> | undefined
  const getClient = (): Promise<MessagesClient> =>
    (clientPromise ??= import('@anthropic-ai/foundry-sdk').then(
      (m) =>
        new m.AnthropicFoundry({
          ...NO_ENV_RESOURCE,
          apiKey: opts.apiKey,
          baseURL: foundryBaseUrl(opts),
          ...(opts.headers && Object.keys(opts.headers).length
            ? { defaultHeaders: opts.headers }
            : {})
        })
    ))

  return createMessagesProvider(getClient)
}

/**
 * Foundry's curated model list. The client explicitly omits the models endpoint
 * (`AnthropicFoundry` overrides it away), so this never reaches the network — same
 * contract as `listBedrockModels`. Which models a resource actually serves depends on
 * what has been deployed to it, so the list is a starting point the user edits.
 */
export function listFoundryModels(): ModelOption[] {
  return FOUNDRY_MODELS.map((id) => ({ id }))
}
