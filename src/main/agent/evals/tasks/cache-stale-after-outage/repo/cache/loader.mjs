/**
 * Memoized async lookups, shared by every request handler.
 *
 *   - `get(key)` resolves to the value for `key`. It loads at most once at a time per
 *     key: callers that ask while a load is in flight share that load.
 *   - A loaded value stays fresh for `ttlMs` after its load finished; the next `get`
 *     after that loads again.
 *   - A failed load is not remembered. Everyone waiting on it gets the error, and the
 *     next `get` tries again.
 *   - `invalidate(key)` forgets the value. A load already in flight still answers the
 *     callers waiting on it, but its result is never cached, and a `get` made after the
 *     invalidate starts a fresh load rather than joining the old one.
 */
export function createLoader(load, { ttlMs = 60_000, now = Date.now } = {}) {
  const values = new Map() // key -> { value, at }
  const inflight = new Map() // key -> promise

  return {
    get(key) {
      const cached = values.get(key)
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value)
      if (inflight.has(key)) return inflight.get(key)
      const pending = load(key).then((value) => {
        values.set(key, { value, at: now() })
        inflight.delete(key)
        return value
      })
      inflight.set(key, pending)
      return pending
    },
    invalidate(key) {
      values.delete(key)
    }
  }
}
