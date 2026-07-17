import type { Provider } from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { VERTEX_MODELS } from '@shared/provider-catalog'
import { createMessagesProvider, type MessagesClient } from './anthropic'

/**
 * Claude on Google Vertex AI.
 *
 * Like bedrock.ts, this only constructs a client: `AnthropicVertex` extends
 * `BaseAnthropic`, so the shared adapter in anthropic.ts handles every wire concern.
 * See `createMessagesProvider`.
 *
 * Houston sends no API key on this path. Auth is Google Application Default
 * Credentials: whatever `gcloud auth application-default login` or a
 * `GOOGLE_APPLICATION_CREDENTIALS` service account leaves on the machine. That's why
 * the kind is keyless, and why the only things Houston configures are *where* to
 * send the request.
 *
 * Keeping it keyless takes one explicit step — see {@link NO_ENV_AUTH}.
 */

/**
 * Suppress `BaseAnthropic`'s environment fallback for the first-party credentials.
 *
 * Its constructor resolves `apiKey`/`authToken` from `ANTHROPIC_API_KEY` /
 * `ANTHROPIC_AUTH_TOKEN` whenever they're left `undefined`, and `AnthropicVertex` —
 * unlike the Bedrock client — does not override `authHeaders()`. So a user who has a
 * first-party Anthropic key exported (the documented way to configure the CLI: see
 * `provider-keys.ts`) and also uses Vertex would send that key to Google as
 * `x-api-key` on every request. Passing explicit nulls stops the fallback at its
 * source: the constructor only reads the env when the value is `undefined`.
 *
 * Cast because the Vertex option type omits both fields. They are nonetheless real
 * constructor options: `AnthropicVertex` forwards `...opts` to the `BaseAnthropic`
 * constructor that reads them.
 */
const NO_ENV_AUTH = { apiKey: null, authToken: null } as object

export interface VertexOptions {
  /** Vertex region (e.g. `us-east5`), or `global`. The SDK falls back to `CLOUD_ML_REGION`. */
  region?: string
  /**
   * Google Cloud project. The SDK falls back to `ANTHROPIC_VERTEX_PROJECT_ID`, then to
   * the project on the resolved credentials, so it is usually inferable.
   */
  projectId?: string
  /** Override the derived `{region}-aiplatform.googleapis.com` endpoint. */
  baseUrl?: string
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
}

/** A provider for Claude on Vertex AI, authenticated with Google ADC. */
export function createVertexProvider(opts: VertexOptions = {}): Provider {
  // Lazy + memoized: google-auth-library is imported only once a turn actually runs.
  let clientPromise: Promise<MessagesClient> | undefined
  const getClient = (): Promise<MessagesClient> =>
    (clientPromise ??= import('@anthropic-ai/vertex-sdk').then(
      (m) =>
        new m.AnthropicVertex({
          ...NO_ENV_AUTH,
          ...(opts.region ? { region: opts.region } : {}),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
          ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
          ...(opts.headers && Object.keys(opts.headers).length
            ? { defaultHeaders: opts.headers }
            : {})
        })
    ))

  return createMessagesProvider(getClient)
}

/**
 * Vertex's curated model list. Vertex exposes no Anthropic Models API, so this never
 * reaches the network — same contract as `listBedrockModels`. Availability varies by
 * region, so the list is a starting point the user edits.
 */
export function listVertexModels(): ModelOption[] {
  return VERTEX_MODELS.map((id) => ({ id }))
}
