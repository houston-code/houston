import { createAuditLog } from './audit.mjs'
import { createCache } from './cache.mjs'
import { createLimiter } from './limiter.mjs'
import { count } from './metrics.mjs'

/**
 * The item service: rate limited per user, cached per path, every request audited.
 * `close()` must leave nothing behind, because the CLI and the tests both create a
 * service, use it, close it, and expect the process to exit.
 */
export function createService({ loadItem, auditSink, perMinute = 60, ttlMs = 60_000 }) {
  const cache = createCache({ ttlMs })
  const limiter = createLimiter({ perMinute })
  const audit = createAuditLog(auditSink)

  return {
    async handle({ user, path }) {
      count('requests')
      if (!limiter.take(user)) {
        count('limited')
        audit.record({ user, path, status: 429 })
        return { status: 429 }
      }
      let item = cache.get(path)
      if (item === undefined) {
        item = await loadItem(path)
        cache.set(path, item)
      }
      audit.record({ user, path, status: 200 })
      return { status: 200, body: item }
    },
    async close() {
      limiter.dispose()
      audit.flush()
    }
  }
}
