import { createHmac, randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'

/**
 * SDK clients shared across turns and side requests, for the hosts whose clients hold
 * auth state that is slow to build again: Vertex (a google-auth client, whose first
 * request exchanges a token) and Bedrock (the AWS credential chain: SSO, an assumed
 * role, a `credential_process`, instance metadata). `createProvider` runs once per run,
 * and the title, suggestion and git side requests build providers of their own, so a
 * client kept on the provider was rebuilt, and its credentials fetched again, for every
 * one of them.
 *
 * A client is keyed on everything it is built from: the provider's settings, the
 * environment variables its SDK falls back to, and stamps of the credential files it
 * reads. A changed setting, a new key or a fresh login therefore builds a new client
 * instead of reusing a stale one. The key is an HMAC under a secret made fresh for each
 * process, so a stored key or a gateway header among the inputs is never kept in the
 * map, or anywhere it could be logged, in a form that could be recovered or guessed.
 */

/** Most clients kept at once; the least recently used one is dropped first. */
export const MAX_SHARED_CLIENTS = 8

const KEY_SECRET = randomBytes(32)
const clients = new Map<string, Promise<unknown>>()

/** JSON with object keys sorted, so the same inputs always make the same key. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/** The cache key for a `kind` client built from `inputs`. Secrets among them are safe here. */
export function clientKey(kind: string, inputs: Record<string, unknown>): string {
  return `${kind}:${createHmac('sha256', KEY_SECRET).update(canonical(inputs)).digest('hex')}`
}

/**
 * A credential file's stamp for a key: its size and modification time, which change when
 * a login rewrites it. Null when there is no such file. The contents are never read.
 */
export function fileStamp(path: string | undefined): string | null {
  if (!path) return null
  try {
    const s = statSync(path)
    return `${s.size}:${s.mtimeMs}`
  } catch {
    return null
  }
}

/** The client cached under `key`, building it with `build` when there is none. */
export function sharedClient<T>(key: string, build: () => Promise<T>): Promise<T> {
  let client = clients.get(key) as Promise<T> | undefined
  if (client) {
    clients.delete(key)
  } else {
    const built = build()
    // A build that failed (its SDK did not load) is not kept, so the next turn tries again.
    built.catch(() => {
      if (clients.get(key) === built) clients.delete(key)
    })
    client = built
  }
  clients.set(key, client)
  for (const oldest of clients.keys()) {
    if (clients.size <= MAX_SHARED_CLIENTS) break
    clients.delete(oldest)
  }
  return client
}

/** Drop the client under `key`, so the next request builds a fresh one. */
export function forgetSharedClient(key: string): void {
  clients.delete(key)
}

/** How many clients are cached. For tests. */
export function sharedClientCount(): number {
  return clients.size
}

/** Drop every cached client. For tests, which build providers against mocked SDKs. */
export function resetSharedClients(): void {
  clients.clear()
}

/**
 * Whether a failed request means the client's credentials were refused: the next turn
 * should then build a fresh client (new keys in a file, a revoked token) rather than
 * keep presenting what was cached.
 */
export function isAuthRejection(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status
  return status === 401 || status === 403
}
