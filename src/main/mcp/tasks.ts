import { McpRpcError, mcpCancelledError, type ElicitationWireResult } from './protocol'

/**
 * The MCP Tasks extension (`io.modelcontextprotocol/tasks`, 2026-07-28). A client
 * declares it in each request's capabilities; a server may then answer a long
 * `tools/call` with a task handle (`resultType: "task"`) instead of the result. The
 * client polls `tasks/get` until the task ends, answers `input_required` with
 * `tasks/update`, and can withdraw it with `tasks/cancel`.
 *
 * Houston polls (it does not subscribe to task notifications) and does not keep task
 * ids across restarts: a task outlives a stopped or restarted run only on the server.
 */

/** The extension's identifier, as declared in capabilities. */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

/** Poll wait when the server suggests none. */
const DEFAULT_POLL_MS = 1_000
/** Bounds on a server's `pollIntervalMs`, so it can neither spin the client nor stall it. */
const MIN_POLL_MS = 250
const MAX_POLL_MS = 30_000
/** Longest Houston follows one task before giving up on it (and cancelling it). */
export const MAX_TASK_MS = 60 * 60_000
/** Most `input_required` rounds one task may ask for. */
const MAX_TASK_INPUT_ROUNDS = 8
/** Longest status message shown as progress. */
const MAX_STATUS_CHARS = 200

/** The wait before the next poll, from the server's suggestion (clamped). */
export function pollDelayMs(pollIntervalMs: unknown): number {
  if (typeof pollIntervalMs !== 'number' || !Number.isFinite(pollIntervalMs)) return DEFAULT_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, pollIntervalMs))
}

/** A server's status message, safe to show on one line. */
export function statusLine(message: unknown): string {
  if (typeof message !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- the server's text is shown in the UI: no control characters
  const flat = message.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim()
  return flat.length > MAX_STATUS_CHARS ? `${flat.slice(0, MAX_STATUS_CHARS - 1)}…` : flat
}

/** Wait `ms`, or less if `signal` aborts; true when the wait ran its course. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** What following a task needs from the client. */
export interface TaskDeps {
  /** Send one request to the server (with the client's usual `_meta`). */
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  /** The run's Stop: the task is cancelled on the server and the call fails as cancelled. */
  signal?: AbortSignal
  /** Answers a form elicitation, as for any other server question. */
  onElicit?: (params: unknown) => Promise<ElicitationWireResult>
  /** Hears each new status message (shown as the call's progress). */
  onStatus?: (message: string) => void
  /** The clock, for tests. */
  now?: () => number
}

/**
 * Follow a task a server created for `method` until it ends, and return what the
 * request would have returned synchronously (`result` of a completed task). A failed
 * task throws the server's error; a task the server cancelled throws. Stop, the time
 * cap, and a question Houston can't answer all send `tasks/cancel` (best-effort) and
 * throw. The result is the server's, so the caller fences it as untrusted like any
 * other result.
 */
export async function followTask(created: unknown, method: string, deps: TaskDeps): Promise<unknown> {
  const task = (created && typeof created === 'object' ? created : {}) as { taskId?: unknown; pollIntervalMs?: unknown }
  if (typeof task.taskId !== 'string' || !task.taskId) throw new Error(`MCP ${method} returned a task without an id`)
  const taskId = task.taskId
  const now = deps.now ?? Date.now
  const started = now()
  let pollMs = task.pollIntervalMs
  let lastStatus = ''
  let inputRounds = 0
  const cancel = (): void => {
    void deps.request('tasks/cancel', { taskId }).catch(() => {})
  }
  const report = (message: unknown): void => {
    const line = statusLine(message)
    if (line && line !== lastStatus) {
      lastStatus = line
      deps.onStatus?.(line)
    }
  }
  report((created as { statusMessage?: unknown }).statusMessage)
  for (;;) {
    if (!(await wait(pollDelayMs(pollMs), deps.signal))) {
      cancel()
      throw mcpCancelledError(method)
    }
    if (now() - started > MAX_TASK_MS) {
      cancel()
      throw new Error(`MCP ${method} ran as a task for over ${MAX_TASK_MS / 60_000} minutes; Houston stopped following it`)
    }
    let state: Record<string, unknown>
    try {
      const got = await deps.request('tasks/get', { taskId })
      state = got && typeof got === 'object' ? (got as Record<string, unknown>) : {}
    } catch (e) {
      if (deps.signal?.aborted) {
        cancel()
        throw mcpCancelledError(method)
      }
      throw e
    }
    pollMs = state.pollIntervalMs ?? pollMs
    report(state.statusMessage)
    switch (state.status) {
      case 'working':
        continue
      case 'completed':
        return state.result && typeof state.result === 'object' ? state.result : {}
      case 'failed': {
        const error = state.error && typeof state.error === 'object' ? (state.error as { code?: number; message?: string; data?: unknown }) : {}
        throw new McpRpcError({ ...error, message: error.message ?? `MCP ${method} task failed` })
      }
      case 'cancelled':
        throw new Error(`MCP ${method} task was cancelled by the server`)
      case 'input_required': {
        if (++inputRounds > MAX_TASK_INPUT_ROUNDS) {
          cancel()
          throw new Error(`MCP ${method} task asked for input ${MAX_TASK_INPUT_ROUNDS} times; Houston stopped answering`)
        }
        const asked =
          state.inputRequests && typeof state.inputRequests === 'object' && !Array.isArray(state.inputRequests)
            ? Object.entries(state.inputRequests as Record<string, unknown>)
            : []
        const inputResponses: Record<string, unknown> = {}
        for (const [key, req] of asked) {
          const r = (req && typeof req === 'object' ? req : {}) as { method?: unknown; params?: unknown }
          const mode = r.params && typeof r.params === 'object' ? (r.params as { mode?: unknown }).mode : undefined
          if (r.method !== 'elicitation/create' || !deps.onElicit || (mode !== undefined && mode !== 'form')) {
            cancel()
            const what = typeof r.method === 'string' ? r.method.slice(0, 60) : 'an unknown request'
            throw new Error(`MCP ${method} task asked for ${what}, which Houston does not offer`)
          }
          inputResponses[key] = await deps.onElicit(r.params).catch((): ElicitationWireResult => ({ action: 'cancel' }))
        }
        if (deps.signal?.aborted) {
          cancel()
          throw mcpCancelledError(method)
        }
        if (asked.length) await deps.request('tasks/update', { taskId, inputResponses })
        // Ask again at once: the answer usually moves the task on.
        pollMs = MIN_POLL_MS
        continue
      }
      default:
        throw new Error(`MCP ${method} task reported an unknown status (${JSON.stringify(state.status).slice(0, 40)})`)
    }
  }
}
