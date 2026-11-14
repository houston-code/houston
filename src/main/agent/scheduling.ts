import type { PermissionRule } from '@shared/types'
import type { ToolCall } from '@shared/agent'
import type { ToolKind } from './tools'

/**
 * Whether a tool call is safe to run concurrently with the other calls in a turn.
 * We only parallelize read-only calls that have no side effects and no gating:
 * not denied/forced-to-ask by a permission rule, not wrapped by a hook (hooks
 * imply ordering/side-effects), and not a read of a credential / secret file
 * (see isSensitiveRead). The concurrent batch never reaches the approval gate, so
 * a sensitive read placed there would skip the prompt it always gets otherwise.
 * Writes, shell, network, and MCP calls always run sequentially so approvals,
 * ordering, and the undo snapshot stay correct.
 */
export function isParallelizableRead(
  kind: ToolKind,
  ruleAction: PermissionRule['action'] | null,
  hasMatchingHook: boolean,
  sensitiveRead: boolean
): boolean {
  return (
    kind === 'read' &&
    ruleAction !== 'deny' &&
    ruleAction !== 'ask' &&
    !hasMatchingHook &&
    !sensitiveRead
  )
}

/**
 * One entry in a segmented turn: the original call plus the index it held in the
 * model's tool_use list, so a segment says exactly which calls it covers.
 */
export interface IndexedCall {
  call: ToolCall
  /** Position of this call in the original toolCalls array (0-based). */
  index: number
}

/**
 * One step of a turn's dispatch, in call order: a batch of parallel-safe calls that
 * run concurrently, or a single call that runs on its own (a barrier).
 */
export type CallSegment =
  | { parallel: true; calls: IndexedCall[] }
  | { parallel: false; call: IndexedCall }

/**
 * Split a turn's tool calls into segments, in their original order: each MAXIMAL
 * run of parallelizable calls (`isParallel`: read-only kind, no gating rule, no
 * hook, not ask_user) is one concurrent batch, and every other call (a write,
 * shell, network, MCP, gated, hooked, or ask_user call) is a barrier segment of its
 * own. The caller runs the segments one after another, so a batch starts only after
 * the barrier before it has finished and the barrier after it waits for the whole
 * batch: a read placed after a write in the same turn still observes the write, and
 * the results come back in call order when each segment is flushed in order.
 *
 * Lazy: `isParallel` is asked about a call only when the segment holding it is
 * requested, so a batch after a barrier is classified once that barrier has run (a
 * rule its approval added, an "Always deny" say, is already in force). The call that
 * ends a batch is asked again after the batch; a call judged a barrier only ever
 * takes the full gate, so judging one early never loosens anything.
 */
export function* callSegments(
  calls: ToolCall[],
  isParallel: (call: ToolCall) => boolean
): Generator<CallSegment, void, undefined> {
  let start = 0
  while (start < calls.length) {
    let end = start
    while (end < calls.length && isParallel(calls[end])) end++
    if (end > start) {
      yield { parallel: true, calls: calls.slice(start, end).map((call, i) => ({ call, index: start + i })) }
      start = end
    } else {
      yield { parallel: false, call: { call: calls[start], index: start } }
      start++
    }
  }
}
