import type { Middleware } from '@anthropic-ai/sdk'
import { ProviderError } from '../agent/retry'

/**
 * A deadline and a Stop for the cloud hosts' credential lookup.
 *
 * Bedrock (SigV4) and Vertex (Google ADC) get their credentials inside the SDK's
 * backend middleware: the AWS credential chain (env, profile, SSO, a
 * `credential_process`, instance metadata) or google-auth-library (a refresh token, the
 * GCE metadata server). The SDK arms its request timer around the network fetch only,
 * after that middleware has run, and the lookup never sees the request's abort signal.
 * So a source that never answers (an SSO session waiting on a browser, a
 * `credential_process` waiting for input, a metadata server lookup on a laptop) held
 * the turn forever with nothing on screen, and Stop could not end it.
 *
 * {@link boundCredentialLookup} wraps the SDK's backend middleware so the part before
 * the request goes out is raced against the abort signal and a deadline. Once the
 * signed request is handed on, the SDK's own timer and the idle-body watchdog take
 * over as before.
 */

/** Longest a credential lookup may take before the turn fails. */
export const CREDENTIAL_LOOKUP_LIMIT_MS = 30_000

/** The credential source a host uses, and how the user gets it working again. */
export interface CredentialSource {
  /** Who is being asked, for the first sentence: "the AWS credential chain". */
  what: string
  /** Credentials for which cloud: "AWS". */
  cloud: string
  /** What usually causes it, and what to run. Plain words, no trailing space. */
  help: string
}

export const AWS_CREDENTIALS: CredentialSource = {
  cloud: 'AWS',
  what: 'the AWS credential chain',
  help:
    'This usually means an expired SSO session, a credential_process that is waiting for input, ' +
    'or a lookup of EC2 instance credentials on a machine outside AWS. ' +
    'Run `aws sso login` (or refresh your credentials another way) and check that `aws sts get-caller-identity` works in a terminal, then retry. ' +
    'A Bedrock API key in the provider settings skips this lookup.'
}

export const GOOGLE_CREDENTIALS: CredentialSource = {
  cloud: 'Google Cloud',
  what: 'Google Application Default Credentials',
  help:
    'This usually means the saved credentials need refreshing, or the lookup is waiting on a Google Cloud metadata server this machine does not have. ' +
    'Run `gcloud auth application-default login` (or set GOOGLE_APPLICATION_CREDENTIALS to a service account key file), then retry.'
}

/**
 * The lookup did not finish within {@link CREDENTIAL_LOOKUP_LIMIT_MS}.
 *
 * Carries status 401 so the retry policy never repeats it (a second attempt waits on
 * the same stuck source) and the failed-turn bar files it under sign-in problems. Its
 * name and message deliberately avoid the words "timeout"/"timed out": the SDK reads
 * those as a network timeout and would replace this error with a bare
 * "Request timed out."
 */
export class CredentialLookupError extends ProviderError {
  constructor(source: CredentialSource, limitMs: number = CREDENTIAL_LOOKUP_LIMIT_MS) {
    super(
      `Houston could not get ${source.cloud} credentials: ${source.what} did not answer within ${Math.round(limitMs / 1000)} seconds. ${source.help}`,
      { status: 401 }
    )
    this.name = 'CredentialLookupError'
  }
}

/** An abort error the SDK recognizes as the caller's own Stop. */
function abortReason(signal: AbortSignal): unknown {
  const reason = signal.reason as unknown
  if (reason instanceof Error && reason.name === 'AbortError') return reason
  const err = new Error('Request was aborted.')
  err.name = 'AbortError'
  return err
}

/**
 * Wrap a host's backend middleware so everything it does before calling `next` (the
 * credential lookup and signing) ends on Stop and fails after `limitMs`. Calling
 * `next` disarms both: from there the request is the SDK's, which already honors the
 * signal and its own timeout. A lookup that finishes after the request was failed is
 * never sent.
 */
export function boundCredentialLookup(
  middleware: ReadonlyArray<Middleware>,
  source: CredentialSource,
  limitMs: number = CREDENTIAL_LOOKUP_LIMIT_MS
): Middleware[] {
  return middleware.map(
    (mw): Middleware =>
      (request, next, ctx) =>
        new Promise<Response>((resolve, reject) => {
          const signal = ctx.options?.signal ?? undefined
          let disarmed = false
          // Set once Stop or the deadline has failed the request: a lookup that
          // finishes after that must not send it anyway, unseen and billed.
          let abandoned = false
          const disarm = (): void => {
            if (disarmed) return
            disarmed = true
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
          }
          const onAbort = (): void => {
            disarm()
            abandoned = true
            reject(abortReason(signal!))
          }
          const timer = setTimeout(() => {
            disarm()
            abandoned = true
            reject(new CredentialLookupError(source, limitMs))
          }, limitMs)
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          mw(
            request,
            (signed) => {
              if (abandoned) return Promise.reject(new Error('Request abandoned before it was sent.'))
              disarm()
              return next(signed)
            },
            ctx
          ).then(
            (res) => {
              disarm()
              resolve(res)
            },
            (err: unknown) => {
              disarm()
              reject(err)
            }
          )
        })
  )
}

/**
 * The {@link CredentialLookupError} behind a provider failure, or undefined. The SDK's
 * message stream rethrows a middleware error wrapped in a generic `AnthropicError`
 * (status and all lost), so look down the `cause` chain.
 */
export function findCredentialLookupError(err: unknown): CredentialLookupError | undefined {
  // Bounded walk: a cause chain can be cyclic.
  for (let e = err, i = 0; e && i < 8; e = (e as { cause?: unknown }).cause, i++) {
    if (e instanceof CredentialLookupError) return e
  }
  return undefined
}
