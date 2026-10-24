/** A TTL cache. Expired entries are swept on a timer so a quiet cache doesn't grow. */
export function createCache({ ttlMs = 60_000, now = Date.now } = {}) {
  const entries = new Map()
  const sweeper = setInterval(() => {
    const t = now()
    for (const [key, e] of entries) if (e.expires <= t) entries.delete(key)
  }, ttlMs)

  return {
    get(key) {
      const e = entries.get(key)
      if (!e || e.expires <= now()) return undefined
      return e.value
    },
    set(key, value) {
      entries.set(key, { value, expires: now() + ttlMs })
    },
    get size() {
      return entries.size
    },
    stop() {
      clearInterval(sweeper)
    }
  }
}
