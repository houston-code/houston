import type { ChatMessage } from '@shared/agent'
import { formatTodoList, parseTodosSafe, type Todo } from '@shared/todos'
import { parsePatch } from './apply-patch'

/**
 * Pinned working memory: a small block that rides every request once anything has
 * been compacted or evicted, and survives compaction losslessly. Compaction summarizes older turns into a lossy synthetic summary and
 * tool-result eviction drops stale outputs — either can quietly lose the anchors a
 * long run must never forget: what the user originally asked for, the live task
 * list, and which files are currently in play. This module rebuilds that anchor
 * block from the persisted message log so it is never summarized or evicted away.
 *
 * Everything here is derived purely from `messages` — no separate mutable store to
 * keep in sync — which keeps the builder a pure function that is trivial to test
 * and immune to drift from the real transcript.
 *
 * WHEN AND WHERE THE BLOCK GOES, AND WHY IT MATTERS FOR COST
 * -----------------------------------------------------------
 * Provider prompt caching is *prefix* matching: a request reuses a cached prefix
 * only up to the first byte that differs from the cached one. The loop's request
 * assembly therefore has to keep the window APPEND-ONLY: each request must extend
 * the previous one rather than rewrite it, across the iterations of a turn AND from
 * one turn to the next, or the cache is missed and everything behind the first
 * difference is re-billed as a fresh cache write.
 *
 * That makes this block's *position and volatility* the hazard, not its size. Its
 * contents move as the run works (a new `read_file` reorders "files in play", a
 * `todo_write` rewrites the list). Pinned at message zero and rebuilt per call, a
 * single file read rewrote byte zero of the window on every iteration. Spliced in
 * front of each turn's request, it moved one turn down the window every turn, so
 * the next turn's first request diverged from the last one's cached prefix right
 * where the block used to be, re-billing the whole previous turn.
 *
 * Three rules keep it cheap, and all are load-bearing:
 *
 *  1. It is only sent once something has actually been compacted or evicted. Until
 *     then the window is the log verbatim and nothing has been lost, so a block
 *     restating it would be pure cost and would make the window differ from the log.
 *  2. The loop places it directly after the compaction summary pair (or at the head
 *     when only eviction has run): a spot that does not move as turns are appended.
 *  3. It is derived from the compacted/evicted head (the messages before the cut or
 *     the eviction watermark, whichever reaches further), which is FROZEN until the
 *     next compaction or eviction. That falls out of the argument the loop passes,
 *     which is why this module takes a head rather than reaching for the whole log
 *     itself. Refreshing it at a compaction or eviction is free: those rewrite the
 *     window at or before the block regardless.
 *
 * Nothing is lost by reading only the head: everything after it is still in the
 * window verbatim, and this block exists for what compaction and eviction took away.
 */

/** Marker prefix on the synthetic pinned block, so the renderer/tests can spot it. */
export const PINNED_MEMORY_PREFIX = 'Pinned working memory (kept verbatim across compaction):'

/** Cap the original-task excerpt so a giant first message can't dominate the block. */
const MAX_TASK_CHARS = 2000
/** Cap the "files in play" list — most recent first, deduped. */
const MAX_FILES = 12
/** Overall guard on the assembled block, so it always stays a small, bounded segment. */
const MAX_BLOCK_CHARS = 6000

/** File-touching tools whose `path` argument names a file the run is working on. */
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'multi_edit'])

/**
 * Paths named by a single file-tool call, in the order they appear. Most tools carry
 * a single `path`; `apply_patch` instead carries a multi-file `patch` envelope, so we
 * parse its markers to surface every file it adds/updates/deletes (including a rename's
 * destination). Returns [] for a call that names no usable path.
 */
function callFilePaths(call: NonNullable<ChatMessage['toolCalls']>[number]): string[] {
  if (call.name === 'apply_patch') {
    const patch = call.arguments.patch
    if (typeof patch !== 'string') return []
    try {
      return parsePatch(patch).flatMap((op) =>
        op.type === 'update' && op.moveTo ? [op.path, op.moveTo] : [op.path]
      )
    } catch {
      // A malformed patch never applied, so it names nothing worth pinning.
      return []
    }
  }
  const path = call.arguments.path
  return typeof path === 'string' ? [path] : []
}

/** Trim to `max` characters on a word-ish boundary, adding an ellipsis marker. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

/** Index of the first user turn (the original task), or -1 when there is none. */
export function originalTaskIndex(messages: ChatMessage[]): number {
  return messages.findIndex((m) => m.role === 'user')
}

/** The first user turn's text — the original task. Empty when there is none. */
export function originalTask(messages: ChatMessage[]): string {
  const i = originalTaskIndex(messages)
  return i === -1 ? '' : messages[i].content.trim()
}

/**
 * The latest todo list, recovered from the most recent `todo_write` call's
 * arguments. We read the call (not the tool result) because the arguments carry the
 * structured `todos` array verbatim; the result is a formatted string. Returns []
 * when the run has no todo list yet.
 */
export function latestTodos(messages: ChatMessage[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const call = messages[i].toolCalls?.find((c) => c.name === 'todo_write')
    if (call) return parseTodosSafe(call.arguments.todos)
  }
  return []
}

/**
 * Files the run has touched, most-recently-first and deduped. Derived from the file
 * paths named by file-oriented tool calls across the whole log — the `path` argument
 * of single-file tools and every path in an `apply_patch` envelope — so it survives
 * even after the turns that read/edited them are compacted away.
 */
export function filesInPlay(messages: ChatMessage[], max = MAX_FILES): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    for (const call of messages[i].toolCalls ?? []) {
      if (!FILE_TOOLS.has(call.name) && call.name !== 'apply_patch') continue
      for (const raw of callFilePaths(call)) {
        const p = raw.trim()
        if (!p || seen.has(p)) continue
        seen.add(p)
        out.push(p)
        if (out.length >= max) break
      }
      if (out.length >= max) break
    }
  }
  return out
}

export interface PinnedMemoryOptions {
  /**
   * Leave out the original-task section: the caller sends that request verbatim
   * elsewhere in the window (still in the tail, or re-sent as a mid-turn anchor), so
   * restating it would only duplicate it.
   */
  omitTask?: boolean
}

/**
 * Build the pinned-memory text block from the full message log, or '' when there is
 * nothing worth pinning (no user turn at all, or nothing left once the task is
 * omitted). Bounded in size on every axis so it stays a small, cheap segment that
 * rides every request.
 */
export function buildPinnedMemory(messages: ChatMessage[], opts: PinnedMemoryOptions = {}): string {
  const task = originalTask(messages)
  if (!task) return ''

  const sections: string[] = opts.omitTask ? [] : [`Original task:\n${clip(task, MAX_TASK_CHARS)}`]

  const todos = latestTodos(messages)
  if (todos.length > 0) {
    sections.push(`Current todo list:\n${formatTodoList(todos)}`)
  }

  const files = filesInPlay(messages)
  if (files.length > 0) {
    sections.push(`Files in play (most recent first):\n${files.map((f) => `- ${f}`).join('\n')}`)
  }

  if (sections.length === 0) return ''
  const body = sections.join('\n\n')
  return clip(`${PINNED_MEMORY_PREFIX}\n\n${body}`, MAX_BLOCK_CHARS)
}

/**
 * Index of the final user turn: at run start, the request the run is answering.
 * The loop freezes it as the turn's start, the boundary compaction may cut inside
 * of and the request it re-sends verbatim when it does. Returns -1 when the log has
 * no user message.
 */
export function lastUserTurnIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}

/**
 * The synthetic user/assistant pair carrying the pinned block, or [] when there's
 * nothing to pin. A *pair* (not a lone user message) keeps role alternation valid
 * where the loop places it, after the summary pair: mirroring how
 * `buildSummaryMessages` frames the compaction summary.
 *
 * Pass the compacted/evicted HEAD of the log, not the whole log: that is what
 * freezes the block between compactions and keeps the provider cache alive. See
 * the note at the top of this module.
 */
export function buildPinnedMessages(
  messages: ChatMessage[],
  opts: PinnedMemoryOptions = {}
): ChatMessage[] {
  const block = buildPinnedMemory(messages, opts)
  if (!block) return []
  return [
    { role: 'user', content: block },
    {
      role: 'assistant',
      content: 'Understood. I will keep the pinned task, todo list, and files in play in mind.'
    }
  ]
}
