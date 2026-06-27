import { APPROVAL_POLICIES, type ApprovalPolicy } from '@shared/types'

/**
 * The next approval policy when cycling with Shift+Tab. Walks the canonical
 * escalating-trust order (plan → ask → auto-edit → full-auto) and wraps. An unknown
 * current value cycles from the start.
 */
export function nextApprovalPolicy(current: ApprovalPolicy, dir: 1 | -1 = 1): ApprovalPolicy {
  const i = APPROVAL_POLICIES.indexOf(current)
  const len = APPROVAL_POLICIES.length
  const next = (Math.max(0, i) + dir + len) % len
  return APPROVAL_POLICIES[next]
}
