import type { PermissionRule } from '@shared/types'
import type { ToolCall } from '@shared/agent'
import type { ToolKind } from './tools'

/**
 * Whether a tool call is safe to run concurrently with the other calls in a turn.
 * We only parallelize read-only calls that have no side effects and no gating:
 * not denied/forced-to-ask by a permission rule, and not wrapped by a hook (hooks
 * imply ordering/side-effects). Writes, shell, network, and MCP calls always run
 * sequentially so approvals, ordering, and the undo snapshot stay correct.
 */
export function isParallelizableRead(
  kind: ToolKind,
  ruleAction: PermissionRule['action'] | null,
  hasMatchingHook: boolean
): boolean {
  return kind === 'read' && ruleAction !== 'deny' && ruleAction !== 'ask' && !hasMatchingHook
}

/**
 * One entry in a partitioned turn: the original call plus the index it held in the
 * model's tool_use list. The index is what lets us reassemble every tool_result in
 * the original call order after the parallel reads and sequential rest have run out
 * of order relative to each other.
 */
export interface IndexedCall {
  call: ToolCall
  /** Position of this call in the original toolCalls array (0-based). */
  index: number
}

/**
 * The result of splitting a mixed turn's calls into the group that can run
 * concurrently (parallelizable reads) and the group that must run sequentially in
 * their original relative order (writes, shell, network, MCP, gated, hooked, and
 * ask_user).
 */
export interface Partition {
  /** Parallelizable reads — safe to dispatch all at once via Promise.all. */
  parallel: IndexedCall[]
  /** Everything else — dispatched one at a time, preserving relative order. */
  sequential: IndexedCall[]
}

/**
 * Partition a turn's tool calls into a concurrently-runnable read group and a
 * strictly-sequential "rest" group, tagging each with its original index so
 * results can be re-sorted into the model-visible order afterward.
 *
 * `isParallel(call)` is the loop's per-call predicate (read-only kind, no gating
 * rule, no hook, not ask_user). We iterate in the original order so the sequential
 * group preserves the model's intended ordering for the encumbered calls.
 */
export function partitionCalls(
  calls: ToolCall[],
  isParallel: (call: ToolCall) => boolean
): Partition {
  const parallel: IndexedCall[] = []
  const sequential: IndexedCall[] = []
  calls.forEach((call, index) => {
    if (isParallel(call)) parallel.push({ call, index })
    else sequential.push({ call, index })
  })
  return { parallel, sequential }
}
