import {
  MCP_REGISTRY_ORIGIN,
  normalizeRegistryPage,
  normalizeRegistryServer,
  type RegistryGetResult,
  type RegistrySearchResult
} from '@shared/mcpRegistry'

/**
 * Read-only client for the official MCP Registry, used by Settings > MCP Servers
 * ("Browse registry", over IPC) and the terminal's `/mcp search`. It only ever sends
 * GET requests to the registry's fixed origin, with the user's search words as the
 * one input; each answer is time-limited, size-capped, reduced to display data by
 * `normalizeRegistryPage`, and cached briefly in memory so paging back and forth or
 * retyping a search doesn't ask again.
 */

export const REGISTRY_TIMEOUT_MS = 10_000
export const REGISTRY_MAX_BYTES = 2 * 1024 * 1024
export const REGISTRY_CACHE_TTL_MS = 5 * 60_000
const CACHE_MAX = 50
const PAGE_SIZE = 30
const MAX_QUERY = 100
const MAX_CURSOR = 300
const MAX_NAME = 200

export interface RegistryClientDeps {
  fetch?: typeof globalThis.fetch
  now?: () => number
  timeoutMs?: number
  maxBytes?: number
}

class RegistryError extends Error {}

/** Read a response body as text, refusing more than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) throw new RegistryError('The registry’s answer was too large.')
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new RegistryError('The registry’s answer was too large.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function errorText(e: unknown): string {
  if (e instanceof RegistryError) return e.message
  const name = (e as { name?: string } | null)?.name
  if (name === 'TimeoutError' || name === 'AbortError') return 'The registry did not answer in time. Try again.'
  return 'Could not reach the MCP Registry. Check your connection and try again.'
}

export function createRegistryClient(deps: RegistryClientDeps = {}): {
  search: (query: string, cursor?: string) => Promise<RegistrySearchResult>
  get: (name: string) => Promise<RegistryGetResult>
  clear: () => void
} {
  const doFetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const max = deps.maxBytes ?? REGISTRY_MAX_BYTES
  const cache = new Map<string, { at: number; value: unknown }>()

  // Holds normalized answers only (small), never raw bodies.
  const getJson = async <T>(path: string, read: (json: unknown) => T): Promise<T> => {
    const url = `${MCP_REGISTRY_ORIGIN}${path}`
    const hit = cache.get(url)
    if (hit && now() - hit.at < REGISTRY_CACHE_TTL_MS) return hit.value as T
    if (hit) cache.delete(url)
    const res = await doFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(deps.timeoutMs ?? REGISTRY_TIMEOUT_MS)
    })
    if (res.status === 404) throw new RegistryError('The registry has no server with that name.')
    if (!res.ok) throw new RegistryError(`The registry answered with an error (${res.status}).`)
    const text = await readCapped(res, max)
    let value: T
    try {
      value = read(JSON.parse(text))
    } catch {
      throw new RegistryError('The registry sent an answer Houston could not read.')
    }
    cache.set(url, { at: now(), value })
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
    return value
  }

  return {
    async search(query, cursor) {
      const q = typeof query === 'string' ? query.trim().slice(0, MAX_QUERY) : ''
      if (q.length > 0 && q.length < 3) return { ok: false, error: 'Type at least 3 characters to search.' }
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), version: 'latest' })
      if (q) params.set('search', q)
      if (typeof cursor === 'string' && cursor) params.set('cursor', cursor.slice(0, MAX_CURSOR))
      try {
        return { ok: true, page: await getJson(`/v0.1/servers?${params.toString()}`, normalizeRegistryPage) }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    },
    async get(name) {
      const n = typeof name === 'string' ? name.trim() : ''
      if (!n || n.length > MAX_NAME || /\s/.test(n)) return { ok: false, error: 'Give the server’s full registry name, as /mcp search lists it.' }
      try {
        const server = await getJson(`/v0.1/servers/${encodeURIComponent(n)}/versions/latest`, normalizeRegistryServer)
        return { ok: true, server }
      } catch (e) {
        return { ok: false, error: errorText(e) }
      }
    },
    clear: () => cache.clear()
  }
}

const shared = createRegistryClient()

/** Search the registry (latest version of each server), one page at a time. */
export const searchMcpRegistry = (query: string, cursor?: string): Promise<RegistrySearchResult> =>
  shared.search(query, cursor)

/** One server's latest entry by its full registry name. */
export const getMcpRegistryServer = (name: string): Promise<RegistryGetResult> => shared.get(name)
