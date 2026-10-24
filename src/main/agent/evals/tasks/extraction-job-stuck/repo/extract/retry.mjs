/**
 * Call `fn`, retrying failures with exponential backoff: `baseMs`, then twice that,
 * and so on, for up to `retries` extra attempts. `sleep` is injected so tests and the
 * offline demo don't actually wait.
 */
export async function withRetry(fn, { retries = 3, baseMs = 500, sleep }) {
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= retries) throw err
      await sleep(baseMs * 2 ** attempt)
      attempt++
    }
  }
}
