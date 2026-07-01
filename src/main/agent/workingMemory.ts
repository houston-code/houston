import type { ChatMessage } from '@shared/agent'
import { formatTodoList, parseTodosSafe, type Todo } from '@shared/todos'
import { parsePatch } from './apply-patch'

/**
 * Pinned working memory: a small, always-present block that survives compaction
 * losslessly. Compaction summarizes older turns into a lossy synthetic summary and
 * tool-result eviction drops stale outputs — either can quietly lose the anchors a
 * long run must never forget: what the user originally asked for, the live task
 * list, and which files are currently in play. This module rebuilds that anchor
 * block from the full (persisted) message log on every turn and the loop prepends
 * it to the sent window, ahead of the summary, so it is never summarized or evicted
 * away.
 *
 * Everything here is derived purely from `messages` — no separate mutable store to
 * keep in sync — which keeps the builder a pure function that is trivial to test
 * and immune to drift from the real transcript.
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

/** The first user turn's text — the original task. Empty when there is none. */
export function originalTask(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  return first ? first.content.trim() : ''
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

/**
 * Build the pinned-memory text block from the full message log, or '' when there is
 * nothing worth pinning yet (no user turn at all). Bounded in size on every axis so
 * it stays a small, cheap segment that rides every request.
 */
export function buildPinnedMemory(messages: ChatMessage[]): string {
  const task = originalTask(messages)
  if (!task) return ''

  const sections: string[] = [`Original task:\n${clip(task, MAX_TASK_CHARS)}`]

  const todos = latestTodos(messages)
  if (todos.length > 0) {
    sections.push(`Current todo list:\n${formatTodoList(todos)}`)
  }

  const files = filesInPlay(messages)
  if (files.length > 0) {
    sections.push(`Files in play (most recent first):\n${files.map((f) => `- ${f}`).join('\n')}`)
  }

  const body = sections.join('\n\n')
  return clip(`${PINNED_MEMORY_PREFIX}\n\n${body}`, MAX_BLOCK_CHARS)
}

/**
 * The synthetic user/assistant pair carrying the pinned block, or [] when there's
 * nothing to pin. A *pair* (not a lone user message) keeps role alternation valid
 * when this is prepended ahead of the summary and the kept tail — mirroring how
 * `buildSummaryMessages` frames the compaction summary.
 */
export function buildPinnedMessages(messages: ChatMessage[]): ChatMessage[] {
  const block = buildPinnedMemory(messages)
  if (!block) return []
  return [
    { role: 'user', content: block },
    {
      role: 'assistant',
      content: 'Understood. I will keep the pinned task, todo list, and files in play in mind.'
    }
  ]
}
