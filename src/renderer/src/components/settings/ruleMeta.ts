import type { PermissionRule, PermissionTestResult } from '@shared/types'
import { APPROVAL_POLICY_LABEL, type ApprovalPolicy } from '@shared/types'

const DAY = 24 * 60 * 60 * 1000

/** "today", "yesterday", "5 days ago", "3 months ago", "2 years ago". */
export function daysAgo(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / DAY))
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months < 24) return `${months} months ago`
  return `${Math.floor(days / 365)} years ago`
}

/**
 * The bookkeeping line under a rule: when and how it was added, and when it last
 * decided a call. Empty when nothing is known. "Not used yet" is said only for a
 * rule whose creation date is known, since usage is recorded only from the version
 * that started recording it and an older rule may well have been used before.
 */
export function ruleMetaText(rule: PermissionRule, lastUsed: number | undefined, now: number): string {
  const parts: string[] = []
  if (typeof rule.addedAt === 'number') {
    const how = rule.source === 'prompt' ? ' from an approval prompt' : rule.source === 'settings' ? ' in Settings' : ''
    parts.push(`Added ${daysAgo(rule.addedAt, now)}${how}`)
  }
  if (typeof lastUsed === 'number') parts.push(`last used ${daysAgo(lastUsed, now)}`)
  else if (typeof rule.addedAt === 'number') parts.push('not used yet')
  const text = parts.join(' · ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : ''
}

/** The rule tester's verdict as one sentence. */
export function testVerdictText(
  result: PermissionTestResult,
  rules: PermissionRule[],
  defaultPolicy: ApprovalPolicy
): string {
  if (result.decision === null) {
    return `No rule matches, so the chat's approval mode decides (new chats start in ${APPROVAL_POLICY_LABEL[defaultPolicy]}).`
  }
  const verb = { allow: 'Allow', ask: 'Ask', deny: 'Deny' }[result.decision]
  switch (result.tier) {
    case 'managed':
      return `${verb}, decided by the administrator policy.`
    case 'project':
      return `${verb}, decided by this project's guardrails.`
    case 'project-allow':
      return `${verb}, decided by this project's allow rules.`
    case 'user': {
      // The deciding rule is the first matching one with the verdict's action (for a
      // compound command, the first that gave it for some part); the rest also match.
      const decider = result.userMatches.find((i) => rules[i]?.action === result.decision) ?? result.userMatches[0]
      const others = result.userMatches.filter((i) => i !== decider).map((i) => i + 1)
      const also = others.length ? ` Also matching: ${others.length === 1 ? 'rule' : 'rules'} ${others.join(', ')}.` : ''
      return `${verb}, decided by your rule ${decider + 1}.${also}`
    }
    default:
      return `${verb}.`
  }
}
