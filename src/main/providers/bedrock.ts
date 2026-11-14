import type { Provider } from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { BEDROCK_MODELS } from '@shared/provider-catalog'
import { createMessagesProvider, type MessagesClient } from './anthropic'
import { idleTimeoutFetch } from './idle-fetch'
import { ProviderError, SDK_MAX_RETRIES } from '../agent/retry'

/**
 * Claude on Amazon Bedrock.
 *
 * Bedrock speaks the Anthropic Messages protocol, and the Mantle client extends
 * `BaseAnthropic` exactly like the first-party SDK, so this file is only about
 * *constructing* the client — every wire concern (streaming, thinking, cache
 * breakpoints, the usage split) belongs to the shared adapter. See
 * `createMessagesProvider` in anthropic.ts.
 *
 * Credentials resolve ambiently, which is the whole point of this kind over the
 * `bedrock` bearer-token preset in the catalog: the Mantle client takes an optional
 * bearer `apiKey`, but otherwise signs with SigV4 off the default AWS credential
 * chain — a `~/.aws/credentials` profile, SSO, or an instance/role identity. Houston
 * passes only what the user configured and lets the SDK resolve the rest, so it never
 * has to model AWS's credential precedence itself.
 */

export interface BedrockOptions {
  /** AWS region. The SDK falls back to `AWS_REGION`, then `AWS_DEFAULT_REGION`. */
  region?: string
  /**
   * Optional Bedrock API key, sent as a bearer token. It takes precedence over AWS
   * credentials inside the SDK, so it is passed only when non-empty: an empty string
   * would suppress SigV4 and leave the client with no usable auth.
   */
  apiKey?: string
  /** Override the derived `bedrock-mantle.{region}.api.aws` endpoint. */
  baseUrl?: string
  /** Extra headers (a gateway's own auth, attribution) sent on every request. */
  headers?: Record<string, string>
}

/** A provider for Claude on Bedrock, over the Mantle (SigV4) client. */
export function createBedrockProvider(opts: BedrockOptions = {}): Provider {
  // Lazy + memoized, like the other adapters: the AWS signing stack is a heavy
  // import, and a user who never selects this provider never pays for it.
  let clientPromise: Promise<MessagesClient> | undefined
  const getClient = (): Promise<MessagesClient> =>
    (clientPromise ??= import('@anthropic-ai/bedrock-sdk').then(
      (m) =>
        new m.AnthropicBedrockMantle({
          fetch: idleTimeoutFetch(),
          maxRetries: SDK_MAX_RETRIES,
          ...(opts.region ? { awsRegion: opts.region } : {}),
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
          ...(opts.headers && Object.keys(opts.headers).length
            ? { defaultHeaders: opts.headers }
            : {})
        })
    ))

  const inner = createMessagesProvider(getClient)
  return {
    async *streamChat(req) {
      try {
        yield* inner.streamChat(req)
      } catch (err) {
        throw explainLegacyModelError(err, req.model)
      }
    }
  }
}

/**
 * Claude models older than 4.7: Claude 3.x and the 4.x line through 4.6, including the
 * dated 4.0 snapshots (`claude-sonnet-4-20250514`) and Bedrock's legacy id shape
 * (`anthropic.claude-3-5-sonnet-20240620-v1:0`). Exported for testing.
 */
export function predatesClaude47(model: string): boolean {
  return /claude-(3\b|3-|(opus|sonnet|haiku)-4(?![-@][7-9]\b))/i.test(model)
}

/**
 * The Anthropic SDK sends API version 2026-10-21, which Bedrock accepts only for Claude
 * 4.7 and later, so a request to an older model there fails with a 400. The curated list
 * holds only newer models, but the user can edit it; when they have added an older one,
 * say what to do instead of leaving them with Bedrock's bare validation error. Any other
 * error, or a 400 for a 4.7+ model, passes through untouched. Exported for testing.
 */
export function explainLegacyModelError(err: unknown, model: string): unknown {
  const status = (err as { status?: unknown })?.status
  if (status !== 400 || !predatesClaude47(model)) return err
  const message = String((err as { message?: unknown })?.message ?? err)
  return new ProviderError(
    `${message}\n\nHouston calls Bedrock with Anthropic API version 2026-10-21, which Bedrock supports only for Claude 4.7 and later. ` +
      `"${model}" is older: choose a Claude 4.7 or later model for this provider in Settings.`,
    { status: 400 }
  )
}

/**
 * Bedrock's curated model list. Bedrock has no Models API — the Mantle client only
 * exposes `messages` — so this never reaches the network, and Fetch simply restores
 * the curated ids. Which of them an account can invoke depends on its region and
 * model access, so the list is a starting point the user edits.
 */
export function listBedrockModels(): ModelOption[] {
  return BEDROCK_MODELS.map((id) => ({ id }))
}
