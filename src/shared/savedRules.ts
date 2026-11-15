import type { ToolApprovalDecision } from './agent'
import { permissionRuleKey, type AppSettings, type PermissionRule } from './types'

/**
 * What "Always allow" / "Always deny" on an approval prompt saved, so a client can name
 * the exact rule and say how to take it back.
 *
 * The main process saves the rule (`addPermissionRule`, stamped `source: 'prompt'` and
 * `addedAt`) as the run applies the decision, right after the approval resolves. A
 * client does not compute the rule itself (shell commands become generalized prefixes,
 * URLs become origins, a patch becomes one rule per file); it reads back the prompt
 * rules stamped since the answer instead.
 */

/** The rule action a decision saves, or null when the decision saves no rule. */
export function ruleActionOf(decision: ToolApprovalDecision): 'allow' | 'deny' | null {
  if (decision === 'rule-allow') return 'allow'
  if (decision === 'rule-deny') return 'deny'
  return null
}

/** Prompt-saved rules of `action` stamped at or after `since`. */
export function savedRulesSince(
  rules: readonly PermissionRule[] | undefined,
  action: 'allow' | 'deny',
  since: number
): PermissionRule[] {
  return (rules ?? []).filter(
    (r) => r.source === 'prompt' && r.action === action && typeof r.addedAt === 'number' && r.addedAt >= since
  )
}

/** One rule as the toast and Settings show it: verdict, tool, and what it matches. */
export function describeRule(r: PermissionRule): string {
  const verdict = r.action === 'allow' ? 'Allow' : r.action === 'deny' ? 'Deny' : 'Ask'
  const tool = r.tool && r.tool !== '*' ? r.tool : 'any tool'
  const match = r.match === '*' ? 'anything' : r.match
  return `${verdict} ${tool}: ${match}`
}

/** The sentence for what was saved (the rules themselves are listed beside it). */
export function savedRulesText(saved: readonly PermissionRule[], action: 'allow' | 'deny'): string {
  if (saved.length === 0) {
    return action === 'allow'
      ? 'Allowed. A saved rule already covers this, so no new rule was added.'
      : 'Denied. A saved rule already covers this, so no new rule was added.'
  }
  return saved.length === 1 ? 'Saved a permission rule:' : `Saved ${saved.length} permission rules:`
}

/** `rules` without the ones in `saved` (matched on what the matcher reads plus when it was added). */
export function withoutRules(rules: readonly PermissionRule[] | undefined, saved: readonly PermissionRule[]): PermissionRule[] {
  const drop = new Set(saved.map(ruleIdentity))
  return (rules ?? []).filter((r) => !drop.has(ruleIdentity(r)))
}

/** A rule's identity across a settings re-read: what the matcher reads plus when it was added. */
export function ruleIdentity(r: PermissionRule): string {
  return `${permissionRuleKey(r)}\u0000${r.addedAt ?? ''}`
}

/** How long to keep looking for the saved rule after the answer, in ms from the answer. */
export const RULE_POLL_DELAYS = [80, 250, 600, 1200] as const

/**
 * Read settings until the rules the answer saved appear, or give up (an existing rule
 * already covered the call, so none was added). Returns the rules and the settings
 * they were read from.
 */
export async function waitForSavedRules(
  read: () => Promise<AppSettings>,
  action: 'allow' | 'deny',
  since: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<{ saved: PermissionRule[]; settings: AppSettings | null }> {
  let waited = 0
  let last: AppSettings | null = null
  for (const at of RULE_POLL_DELAYS) {
    await sleep(at - waited)
    waited = at
    last = await read()
    const saved = savedRulesSince(last.permissionRules, action, since)
    if (saved.length > 0) return { saved, settings: last }
  }
  return { saved: [], settings: last }
}
