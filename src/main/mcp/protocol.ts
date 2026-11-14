/**
 * Transport-agnostic JSON-RPC plumbing shared by the three MCP clients (stdio,
 * streamable HTTP, HTTP+SSE): classifying incoming messages, answering
 * server-initiated requests, reacting to server notifications, and tracking
 * pending requests with progress-aware timeouts.
 *
 * Server-to-client traffic a client must not drop on the floor:
 *
 * - `ping` requests get an empty result (the server is checking liveness).
 * - Any other server-initiated request (`elicitation/create`,
 *   `sampling/createMessage`, `roots/list`, …) targets a capability Houston does
 *   not declare, so it is answered with JSON-RPC -32601 (method not found)
 *   rather than ignored — a dropped request would leave the server awaiting a
 *   reply forever, wedging the session.
 * - `notifications/<kind>/list_changed` marks the relevant list (tools,
 *   resources, prompts) for an in-place re-fetch.
 * - `notifications/progress` proves a slow tool call is alive: it resets that
 *   call's inactivity timeout (up to an absolute ceiling) instead of letting a
 *   long-but-healthy call die at the fixed timeout.
 */

/** One incoming JSON-RPC message, loosely typed at the trust boundary. */
export interface JsonRpcIncoming {
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string }
}

export type IncomingKind = 'response' | 'request' | 'notification' | 'other'

/** Parse arbitrary JSON into a message object, or null for non-object noise. */
export function parseIncoming(raw: unknown): JsonRpcIncoming | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as JsonRpcIncoming) : null
}

/** Classify a message: a request has method+id, a notification method only. */
export function kindOf(msg: JsonRpcIncoming): IncomingKind {
  const hasId = typeof msg.id === 'number' || typeof msg.id === 'string'
  if (typeof msg.method === 'string') return hasId ? 'request' : 'notification'
  if (hasId && ('result' in msg || 'error' in msg)) return 'response'
  return 'other'
}

export type McpListKind = 'tools' | 'resources' | 'prompts'

/** The wire shape of an elicitation response (MCP `elicitation/create` result). */
export interface ElicitationWireResult {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
}

export interface ServerMessageHooks {
  /** Send a JSON-RPC payload back to the server. Best-effort; must not throw. */
  send(payload: unknown): void
  /** A `notifications/<kind>/list_changed` arrived. */
  onListChanged(kind: McpListKind): void
  /** Restart the inactivity timeout of the in-flight request with this token. */
  touchProgress(token: number | string): void
  /**
   * Answer a server's `elicitation/create` request (the server is asking the
   * user for input mid-call). Must always resolve — return a 'decline' when no
   * user is reachable — so the server is never left awaiting a reply. When
   * absent, elicitation requests get the -32601 decline like any other
   * unsupported request (and the client must not declare the capability).
   */
  onElicit?(params: unknown): Promise<ElicitationWireResult>
}

const LIST_CHANGED: Record<string, McpListKind> = {
  'notifications/tools/list_changed': 'tools',
  'notifications/resources/list_changed': 'resources',
  'notifications/prompts/list_changed': 'prompts'
}

/** Whether an `elicitation/create` asks for a form: `mode` absent (before 2025-11-25) or `"form"`. */
function isFormElicitation(params: unknown): boolean {
  const mode = params && typeof params === 'object' ? (params as { mode?: unknown }).mode : undefined
  return mode === undefined || mode === 'form'
}

/**
 * Handle a server-initiated message (request or notification). Responses are the
 * caller's business (they resolve its pending table); everything else lands here.
 */
export function handleServerMessage(msg: JsonRpcIncoming, hooks: ServerMessageHooks): void {
  const kind = kindOf(msg)
  if (kind === 'request') {
    if (msg.method === 'ping') {
      hooks.send({ jsonrpc: '2.0', id: msg.id, result: {} })
    } else if (msg.method === 'elicitation/create' && hooks.onElicit && !isFormElicitation(msg.params)) {
      // 2025-11-25 added URL mode (send the user to a web page). Houston declares only
      // form mode (an empty `elicitation` capability means form), so a server must not
      // ask for it; one that does is refused rather than shown as an empty form the user
      // could "accept".
      hooks.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'This client supports only form elicitation' }
      })
    } else if (msg.method === 'elicitation/create' && hooks.onElicit) {
      // The user decides at their own pace; the responder always resolves (a
      // failure maps to 'cancel'), so the server always gets its reply.
      void hooks
        .onElicit(msg.params)
        .catch((): ElicitationWireResult => ({ action: 'cancel' }))
        .then((result) => hooks.send({ jsonrpc: '2.0', id: msg.id, result }))
    } else {
      hooks.send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `This client does not support ${msg.method}` }
      })
    }
    return
  }
  if (kind !== 'notification') return
  const listKind = LIST_CHANGED[msg.method ?? '']
  if (listKind) {
    hooks.onListChanged(listKind)
    return
  }
  if (msg.method === 'notifications/progress') {
    const token = (msg.params as { progressToken?: unknown } | undefined)?.progressToken
    if (typeof token === 'number' || typeof token === 'string') hooks.touchProgress(token)
  }
  // Other notifications (logging `notifications/message`, a server's own `notifications/cancelled`,
  // `notifications/initialized` echoes, …) are deliberately ignored.
}

/**
 * Serialized, coalescing re-fetcher for `list_changed` notifications: a burst of
 * notifications for one list kind triggers a single re-fetch, kinds never
 * overlap, and a failed re-fetch keeps the previous list (the next notification
 * or a reconnect heals it). Each client supplies its own transport `fetch`.
 */
export class ListRefresher {
  private chain = Promise.resolve()
  private readonly queued = new Set<McpListKind>()

  constructor(
    private readonly deps: {
      isClosed: () => boolean
      capable: (kind: McpListKind) => boolean
      fetch: (kind: McpListKind) => Promise<void>
    }
  ) {}

  schedule(kind: McpListKind): void {
    if (this.deps.isClosed() || !this.deps.capable(kind) || this.queued.has(kind)) return
    this.queued.add(kind)
    this.chain = this.chain
      .then(async () => {
        this.queued.delete(kind)
        if (this.deps.isClosed()) return
        await this.deps.fetch(kind)
      })
      .catch(() => {
        this.queued.delete(kind)
      })
  }
}

/**
 * Absolute ceiling for one request, no matter how much progress the server
 * reports — the inactivity timeout may keep resetting, but never past this.
 */
export const MAX_REQUEST_TOTAL_MS = 15 * 60_000

/**
 * The error a request settles with when its caller's signal aborts (the user pressed
 * Stop). The agent loop already ends a stopped run on any tool error, so this needs no
 * special type; the message only has to say what happened.
 */
export function mcpCancelledError(method: string): Error {
  return new Error(`MCP ${method} was cancelled`)
}

/** Why Houston cancelled a request, as told to the server in `notifications/cancelled`. */
export const MCP_CANCEL_REASON = 'The user stopped the request.'

/**
 * The MCP cancellation notification for request `id` (spec: `notifications/cancelled`
 * with the request's id and an optional reason). A server that already answered, or
 * never saw the request, ignores it.
 */
export function cancelledNotification(id: number | string, reason = MCP_CANCEL_REASON): unknown {
  return { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason } }
}

/** What a caller can attach to one pending request. */
export interface WaitOptions {
  /**
   * The caller's Stop. When it aborts, the request settles at once with
   * {@link mcpCancelledError} and `onCancel` runs (to tell the server), instead of
   * waiting out the inactivity timeout or the absolute ceiling.
   */
  signal?: AbortSignal
  /** Runs once when `signal` cancels a still-pending request. Must not throw. */
  onCancel?: () => void
}

interface PendingEntry {
  method: string
  settle: (outcome: { value?: unknown; error?: Error }) => void
  restartInactivity: () => void
}

/**
 * The pending-request table every transport keeps: id -> outstanding promise,
 * with an inactivity timeout that `touch(id)` (a progress notification) restarts
 * and an absolute deadline that nothing moves.
 */
export class PendingRequests {
  private readonly entries = new Map<number | string, PendingEntry>()

  get size(): number {
    return this.entries.size
  }

  has(id: number | string): boolean {
    return this.entries.has(id)
  }

  /** Register a request and get the promise its response will settle. */
  wait(
    id: number | string,
    method: string,
    inactivityMs: number,
    maxTotalMs = MAX_REQUEST_TOTAL_MS,
    opts: WaitOptions = {}
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const { signal, onCancel } = opts
      let inactivity: ReturnType<typeof setTimeout> | undefined
      // The run's signal outlives this request: the listener goes when it settles.
      const onAbort = (): void => {
        if (!this.entries.has(id)) return
        settle({ error: mcpCancelledError(method) })
        try {
          onCancel?.()
        } catch {
          // Telling the server is best-effort.
        }
      }
      const deadline = setTimeout(
        () => settle({ error: new Error(`MCP ${method} exceeded the ${Math.round(maxTotalMs / 60000)} min ceiling`) }),
        maxTotalMs
      )
      const settle = (outcome: { value?: unknown; error?: Error }): void => {
        if (!this.entries.has(id)) return
        this.entries.delete(id)
        clearTimeout(inactivity)
        clearTimeout(deadline)
        signal?.removeEventListener('abort', onAbort)
        if (outcome.error) reject(outcome.error)
        else resolve(outcome.value)
      }
      const restartInactivity = (): void => {
        clearTimeout(inactivity)
        inactivity = setTimeout(() => settle({ error: new Error(`MCP ${method} timed out`) }), inactivityMs)
      }
      restartInactivity()
      this.entries.set(id, { method, settle, restartInactivity })
      if (signal?.aborted) settle({ error: mcpCancelledError(method) })
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Settle a pending request from a JSON-RPC response message. No-op if unknown. */
  settle(id: number | string, msg: JsonRpcIncoming): void {
    const entry = this.entries.get(id)
    if (!entry) return
    if (msg.error) entry.settle({ error: new Error(msg.error.message ?? 'MCP error') })
    else entry.settle({ value: msg.result })
  }

  /** Reject a pending request (transport failure before any response). */
  reject(id: number | string, error: Error): void {
    this.entries.get(id)?.settle({ error })
  }

  /**
   * Restart every pending request's inactivity clock. Used while an elicitation
   * dialog is open: the server is waiting on the user (and may send no progress),
   * so the in-flight call that triggered it must not time out underneath them.
   * The absolute deadline still applies.
   */
  touchAll(): void {
    for (const entry of this.entries.values()) entry.restartInactivity()
  }

  /** Progress arrived for this token: the call is alive, restart its clock. */
  touch(id: number | string): void {
    this.entries.get(id)?.restartInactivity()
  }

  /** Reject everything (stream died, process exited, client closed). */
  failAll(message: string): void {
    for (const entry of [...this.entries.values()]) entry.settle({ error: new Error(message) })
  }
}

/**
 * Run an elicitation responder while keeping every pending request's inactivity
 * clock alive: the server is blocked on the user's answer, so the tool call that
 * triggered the question must not time out while the dialog is open.
 */
export async function keepAliveDuring<T>(
  pending: PendingRequests,
  work: () => Promise<T>,
  intervalMs = 30_000
): Promise<T> {
  pending.touchAll()
  const timer = setInterval(() => pending.touchAll(), intervalMs)
  try {
    return await work()
  } finally {
    clearInterval(timer)
  }
}

/**
 * Cap MCP-sourced text (tool results, resources, prompts) before it reaches the
 * agent's context window: MCP servers are external and a hostile or buggy one
 * must not be able to flood the conversation with an unbounded payload.
 */
export const MAX_MCP_OUTPUT_CHARS = 50_000

export function capMcpOutput(text: string, max = MAX_MCP_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[truncated: the MCP server returned ${text.length} chars]`
}

/** The most pages one list walk (`tools/list` and the like) follows before it stops. */
export const MAX_LIST_PAGES = 50

/** The most entries one list walk keeps, across all its pages. */
export const MAX_LIST_ITEMS = 5_000

/** The longest `nextCursor` followed; a longer one ends the walk. */
const MAX_CURSOR_CHARS = 4_096

/** A paginated list result: the merged entries, and why the walk stopped early (if it did). */
export interface ListedPages {
  tools?: unknown[]
  resources?: unknown[]
  prompts?: unknown[]
  /** Set when a cap or a bad cursor ended the walk before the server's last page. */
  truncated?: string
}

/**
 * Walk a paginated MCP list (`tools/list`, `resources/list`, `prompts/list`) by
 * following `nextCursor` and merging every page's `key` array. Each page is a
 * request of its own (with its own timeout), and an error on any page fails the
 * walk, as an error on a single page always has. A server is external and may be
 * hostile or buggy, so the walk is bounded: at most {@link MAX_LIST_PAGES} pages and
 * {@link MAX_LIST_ITEMS} entries, a cursor that repeats or is not a short non-empty
 * string ends it, and `truncated` says when that cut the list short. A first page
 * without a `key` array yields an object without that key (callers that keep the old
 * list on a malformed answer still can).
 */
export async function listAllPages(
  fetchPage: (params: Record<string, unknown>) => Promise<unknown>,
  key: 'tools' | 'resources' | 'prompts'
): Promise<ListedPages> {
  const items: unknown[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; ; page++) {
    const res = await fetchPage(cursor === undefined ? {} : { cursor })
    const list = res && typeof res === 'object' ? (res as Record<string, unknown>)[key] : undefined
    if (!Array.isArray(list)) return page === 0 ? {} : { [key]: items }
    const room = MAX_LIST_ITEMS - items.length
    items.push(...list.slice(0, room))
    if (list.length > room) return { [key]: items, truncated: `the list was cut at ${MAX_LIST_ITEMS} entries` }
    const next = (res as { nextCursor?: unknown }).nextCursor
    if (next === undefined || next === null || next === '') return { [key]: items }
    if (typeof next !== 'string' || next.length > MAX_CURSOR_CHARS) {
      return { [key]: items, truncated: 'the server sent a malformed page cursor, so later pages were skipped' }
    }
    if (seen.has(next)) {
      return { [key]: items, truncated: 'the server repeated a page cursor, so later pages were skipped' }
    }
    if (page + 1 >= MAX_LIST_PAGES) {
      return { [key]: items, truncated: `only the first ${MAX_LIST_PAGES} pages were read` }
    }
    seen.add(next)
    cursor = next
  }
}
