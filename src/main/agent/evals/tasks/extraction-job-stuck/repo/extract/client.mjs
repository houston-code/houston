/** An HTTP error from the model API, with the status the retry policy keys on. */
export class ApiError extends Error {
  constructor(status, message) {
    super(`HTTP ${status}: ${message}`)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * A minimal client for the model's generate endpoint. `fetch` is injected so the
 * job can run against a fake in tests and offline demos.
 */
export function createModelClient({ fetch, model, apiKey }) {
  return {
    async extract(prompt) {
      const res = await fetch(`https://models.example.test/v1/${model}:generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ prompt })
      })
      const body = await res.json()
      if (!res.ok) throw new ApiError(res.status, body?.error?.message ?? 'request failed')
      return body.fields
    }
  }
}
