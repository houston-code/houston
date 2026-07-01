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
 * The result of splitting a turn's calls into the leading group that can run
 * concurrently (parallelizable reads with no preceding encumbered call) and the
 * group that must run sequentially in their original relative order (the first
 * non-parallelizable call — a write, shell, network, MCP, gated, hooked, or
 * ask_user — and everything after it, including any reads).
 */
export interface Partition {
  /** Leading parallelizable reads — safe to dispatch all at once via Promise.all. */
  parallel: IndexedCall[]
  /** Everything from the first encumbered call on — dispatched one at a time, in order. */
  sequential: IndexedCall[]
}

/**
 * Partition a turn's tool calls into a concurrently-runnable read group and a
 * strictly-sequential "rest" group, tagging each with its original index so
 * results can be re-sorted into the model-visible order afterward.
 *
 * `isParallel(call)` is the loop's per-call predicate (read-only kind, no gating
 * rule, no hook, not ask_user). We only parallelize the CONTIGUOUS LEADING run of
 * parallelizable reads, up to the FIRST non-parallelizable call; that call and
 * everything after it (including any later reads) run sequentially in order. This
 * preserves intra-turn causality — a read that follows a write/shell in the same
 * turn observes the just-written result rather than racing ahead of it. When there
 * are no encumbered calls this reduces to the all-reads fast path (empty
 * `sequential`); when the first call is encumbered it reduces to a fully-sequential
 * run (empty `parallel`).
 */
export function partitionCalls(
  calls: ToolCall[],
  isParallel: (call: ToolCall) => boolean
): Partition {
  let split = 0
  while (split < calls.length && isParallel(calls[split])) split++
  const parallel: IndexedCall[] = calls
    .slice(0, split)
    .map((call, index) => ({ call, index }))
  const sequential: IndexedCall[] = calls
    .slice(split)
    .map((call, i) => ({ call, index: split + i }))
  return { parallel, sequential }
}
