import {
  MEMORY_STORE_SCOPES,
  MEMORY_TYPES,
  type MemoryOverview,
  type MemoryRequest,
  type MemoryResponse,
  type MemoryStoreScope,
  type MemoryType
} from '@shared/memoryTypes'
import { MemoryError, memoryStore, type MemoryStore } from './agent/memoryStore'

/**
 * The Memory settings page's one channel into the store. The renderer is not trusted
 * to shape a request, so every field is checked here before it reaches the store
 * (which checks again: sizes, ids, credentials). Every action answers with the
 * refreshed overview, so the page never shows a list that disagrees with disk.
 */

const str = (v: unknown): v is string => typeof v === 'string'
const isScope = (v: unknown): v is MemoryStoreScope =>
  str(v) && (MEMORY_STORE_SCOPES as readonly string[]).includes(v)
const isType = (v: unknown): v is MemoryType => str(v) && (MEMORY_TYPES as readonly string[]).includes(v)

/** The request, or null when it is malformed. */
export function parseMemoryRequest(raw: unknown): MemoryRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!str(r.workspace)) return null
  const workspace = r.workspace
  switch (r.op) {
    case 'list':
      return { op: 'list', workspace }
    case 'remove':
    case 'restore':
      return isScope(r.scope) && str(r.id) ? { op: r.op, workspace, scope: r.scope, id: r.id } : null
    case 'pin':
      return isScope(r.scope) && str(r.id) && typeof r.pinned === 'boolean'
        ? { op: 'pin', workspace, scope: r.scope, id: r.id, pinned: r.pinned }
        : null
    case 'update':
      return isScope(r.scope) &&
        str(r.id) &&
        isType(r.type) &&
        str(r.name) &&
        str(r.description) &&
        str(r.body) &&
        str(r.expectedUpdated)
        ? {
            op: 'update',
            workspace,
            scope: r.scope,
            id: r.id,
            type: r.type,
            name: r.name,
            description: r.description,
            body: r.body,
            expectedUpdated: r.expectedUpdated
          }
        : null
    case 'adoptRepo':
    case 'removeRepo':
      return str(r.key) ? { op: r.op, workspace, key: r.key } : null
    default:
      return null
  }
}

export function memoryOverview(store: MemoryStore): MemoryOverview {
  const key = store.currentRepoKey
  return {
    repo: key !== undefined ? { key, label: store.currentRepoLabel ?? key } : null,
    repoMemories: key !== undefined ? store.list('repo') : [],
    globalMemories: store.list('global'),
    otherRepos: store.listRepos().filter((r) => r.key !== key && r.count > 0)
  }
}

/** Run one page request against the store at `root` (the default store when omitted). */
export async function handleMemoryRequest(raw: unknown, root?: string): Promise<MemoryResponse> {
  const req = parseMemoryRequest(raw)
  const workspace = req && req.workspace.trim() ? req.workspace : undefined
  const store = memoryStore({ ...(root ? { root } : {}), ...(workspace ? { workspace } : {}) })
  if (!req) return { ok: false, error: 'That request was malformed.', overview: memoryOverview(store) }
  try {
    const note = await apply(store, req)
    return { ok: true, overview: memoryOverview(store), ...(note ? { note } : {}) }
  } catch (err) {
    const error = err instanceof MemoryError ? err.message : 'Could not change the memory. Try again.'
    return { ok: false, error, overview: memoryOverview(store) }
  }
}

async function apply(store: MemoryStore, req: MemoryRequest): Promise<string | undefined> {
  switch (req.op) {
    case 'list':
      return undefined
    case 'update': {
      const current = store.get(req.scope, req.id)
      if (!current) throw new MemoryError('not-found', 'That memory no longer exists.')
      await store.save({
        scope: req.scope,
        id: req.id,
        type: req.type,
        name: req.name,
        description: req.description,
        body: req.body,
        origin: 'user',
        expectedUpdated: req.expectedUpdated
      })
      return undefined
    }
    case 'remove':
      return (await store.remove(req.scope, req.id)) ? undefined : 'That memory was already deleted.'
    case 'restore':
      return (await store.restore(req.scope, req.id)) ? undefined : 'That memory can no longer be restored.'
    case 'pin':
      await store.setPinned(req.scope, req.id, req.pinned)
      return undefined
    case 'adoptRepo': {
      const { moved, skipped } = await store.adoptRepo(req.key)
      return skipped
        ? `Moved ${moved} ${moved === 1 ? 'memory' : 'memories'}; ${skipped} stayed behind (same name here, or this repository is full).`
        : `Moved ${moved} ${moved === 1 ? 'memory' : 'memories'} into this repository.`
    }
    case 'removeRepo': {
      const n = await store.removeRepo(req.key)
      return `Deleted ${n} ${n === 1 ? 'memory' : 'memories'} (kept in the memory folder's trash for 30 days).`
    }
  }
}
