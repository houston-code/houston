import type { Middleware } from '@anthropic-ai/sdk'
import type { BedrockMantleClientOptions } from '@anthropic-ai/bedrock-sdk'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Provider } from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { BEDROCK_MODELS } from '@shared/provider-catalog'
import { createMessagesProvider, type MessagesClient } from './anthropic'
import { idleTimeoutFetch } from './idle-fetch'
import { ProviderError, SDK_MAX_RETRIES } from '../agent/retry'
import { AWS_CREDENTIALS, boundCredentialLookup, findCredentialLookupError } from './cloud-credentials'
import { clientKey, fileStamp, forgetSharedClient, isAuthRejection, sharedClient } from './client-cache'

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

type CredentialChainResolver = NonNullable<BedrockMantleClientOptions['providerChainResolver']>

/**
 * One AWS credential chain for the life of a client. Left to itself the SDK builds a
 * fresh default chain for every request it signs, and a fresh chain remembers nothing:
 * each request of every turn went back to SSO, STS, a `credential_process` or instance
 * metadata. This is the same chain (environment first, then the Node default chain),
 * built once, so the credentials it resolves are reused until they near expiry, when
 * it refreshes them. A failed lookup is not remembered.
 */
function memoizedCredentialChain(): CredentialChainResolver {
  let chain: ReturnType<CredentialChainResolver> | undefined
  return () =>
    (chain ??= import('@aws-sdk/credential-providers').then(
      ({ createCredentialChain, fromEnv, fromNodeProviderChain }) =>
        createCredentialChain(fromEnv(), fromNodeProviderChain()),
      (err: unknown) => {
        chain = undefined
        throw err
      }
    ))
}

/**
 * The shared-client key for these options (see client-cache.ts): the settings, the SDK's
 * environment fallbacks for them, the bearer key, and what the AWS chain reads (its
 * environment variables and the shared credentials and config files), so a new key, a
 * new profile or rewritten credentials get a new client. Exported for testing.
 */
export function bedrockClientKey(opts: BedrockOptions): string {
  const env = process.env
  return clientKey('bedrock', {
    region: opts.region || env.AWS_REGION || env.AWS_DEFAULT_REGION,
    baseUrl: opts.baseUrl || env.ANTHROPIC_BEDROCK_MANTLE_BASE_URL,
    headers: opts.headers,
    apiKey: opts.apiKey || env.AWS_BEARER_TOKEN_BEDROCK,
    aws: [
      env.AWS_PROFILE,
      env.AWS_ACCESS_KEY_ID,
      env.AWS_SECRET_ACCESS_KEY,
      env.AWS_SESSION_TOKEN,
      fileStamp(env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), '.aws', 'credentials')),
      fileStamp(env.AWS_CONFIG_FILE || join(homedir(), '.aws', 'config'))
    ]
  })
}

/** A provider for Claude on Bedrock, over the Mantle (SigV4) client. */
export function createBedrockProvider(opts: BedrockOptions = {}): Provider {
  // Lazy, like the other adapters: the AWS signing stack is a heavy import, and a user
  // who never selects this provider never pays for it. Shared across turns and side
  // requests, with its credential chain, so credentials are looked up once, not per request.
  const key = bedrockClientKey(opts)
  const getClient = (): Promise<MessagesClient> =>
    sharedClient(key, () => import('@anthropic-ai/bedrock-sdk').then((m) => {
      // The SigV4 credential lookup runs before the SDK's request timer and ignores
      // the abort signal, so bound it here (see cloud-credentials.ts).
      class BoundedMantle extends m.AnthropicBedrockMantle {
        protected override backendMiddleware(): ReadonlyArray<Middleware> {
          return boundCredentialLookup(super.backendMiddleware(), AWS_CREDENTIALS)
        }
      }
      return new BoundedMantle({
        fetch: idleTimeoutFetch(),
        maxRetries: SDK_MAX_RETRIES,
        // Consulted only to sign: a bearer key skips SigV4 and never calls it.
        providerChainResolver: memoizedCredentialChain(),
        ...(opts.region ? { awsRegion: opts.region } : {}),
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
        ...(opts.headers && Object.keys(opts.headers).length
          ? { defaultHeaders: opts.headers }
          : {})
      })
    }))

  const inner = createMessagesProvider(getClient)
  return {
    async *streamChat(req) {
      try {
        yield* inner.streamChat(req)
      } catch (err) {
        const lookup = findCredentialLookupError(err)
        if (lookup) {
          // Start the next turn from a fresh client: the stuck lookup is cached in its chain.
          forgetSharedClient(key)
          throw lookup
        }
        // Credentials AWS refused (rotated keys, a revoked session) are looked up afresh.
        if (isAuthRejection(err)) forgetSharedClient(key)
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
