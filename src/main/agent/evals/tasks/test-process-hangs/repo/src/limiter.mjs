/** Per-user token bucket: `perMinute` requests, refilled one token at a time. */
export function createLimiter({ perMinute }) {
  const buckets = new Map()
  const refill = setInterval(() => {
    for (const [user, tokens] of buckets) {
      if (tokens + 1 >= perMinute) buckets.delete(user)
      else buckets.set(user, tokens + 1)
    }
  }, 60_000 / perMinute)

  return {
    take(user) {
      const tokens = buckets.get(user) ?? perMinute
      if (tokens <= 0) return false
      buckets.set(user, tokens - 1)
      return true
    },
    dispose() {
      buckets.clear()
    }
  }
}
