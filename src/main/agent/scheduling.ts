import type { PermissionRule } from '@shared/types'
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
