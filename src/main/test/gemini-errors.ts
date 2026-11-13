/**
 * Gemini API error bodies shaped like the real ones, for tests of how a quota or rate
 * limit is classified. Gemini words every quota the same way ("You exceeded your current
 * quota"), whether it resets in a minute or tomorrow; only the `google.rpc.QuotaFailure`
 * detail's `quotaId` says which window ran out, and a `google.rpc.RetryInfo` detail says
 * how long to wait.
 */

/** A per-minute free-tier request quota: waiting `retryDelay` is the cure. */
export const GEMINI_PER_MINUTE_QUOTA_ID = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'

/** A per-day free-tier request quota: nothing short of tomorrow (or billing) fixes it. */
export const GEMINI_PER_DAY_QUOTA_ID = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'

/**
 * The JSON body Gemini answers a quota 429 with. `retryDelay` is the `RetryInfo` value
 * (a protobuf Duration string such as `"41s"`); leave it out to omit that detail.
 * `retryText` is the "Please retry in Ns." sentence the message ends with.
 */
export function geminiQuotaBody(opts: {
  quotaId: string
  retryDelay?: string
  retryText?: string
}): { error: Record<string, unknown> } {
  const details: Record<string, unknown>[] = [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [
        {
          quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
          quotaId: opts.quotaId,
          quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' },
          quotaValue: '10'
        }
      ]
    },
    {
      '@type': 'type.googleapis.com/google.rpc.Help',
      links: [
        { description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }
      ]
    }
  ]
  if (opts.retryDelay !== undefined) {
    details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: opts.retryDelay })
  }
  return {
    error: {
      code: 429,
      message:
        'You exceeded your current quota, please check your plan and billing details. For more ' +
        'information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n' +
        '* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
        'limit: 10, model: gemini-2.5-flash' +
        (opts.retryText ? `\n${opts.retryText}` : ''),
      status: 'RESOURCE_EXHAUSTED',
      details
    }
  }
}

/**
 * The error the Gemini SDK throws for such a response: an `ApiError` whose message is
 * the response body serialized as JSON, with the HTTP status beside it and no headers.
 */
export function geminiApiError(status: number, body: unknown): Error & { status: number } {
  return Object.assign(new Error(JSON.stringify(body)), { name: 'ApiError', status })
}
