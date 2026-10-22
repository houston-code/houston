import type { PermissionRule } from './types'

/**
 * Static checks over a permission-rule list, for the editors that show one (the
 * Settings rules list and its text view). Rules are matched top to bottom and the
 * first match wins (see matchRule in main/agent/permissions.ts), so a rule's place
 * in the list is part of its meaning. These checks only flag what is certain from
 * the rules themselves, never what depends on a particular call:
 *
 * - `empty`: a blank pattern matches nothing, so the rule never applies.
 * - `shadowed`: an earlier rule for the same (or every) tool already matches every
 *   call this one could, because its pattern is `*` or the identical pattern. The
 *   later rule never decides anything. When the two disagree on the action the
 *   earlier one silently wins, which is the case worth warning about.
 * - `broad-allow`: an allow whose pattern is `*`, which approves every call of that
 *   tool (every tool, for tool `*`) without asking.
 */
export type RuleIssue =
  | { kind: 'empty' }
  | { kind: 'shadowed'; by: number; conflicting: boolean }
  | { kind: 'broad-allow' }

/** Whether rule `a` (earlier) applies to every tool rule `b` applies to. */
function coversTool(a: PermissionRule, b: PermissionRule): boolean {
  const at = a.tool || '*'
  const bt = b.tool || '*'
  return at === '*' || at === bt
}

/** Whether rule `a` matches every subject rule `b` matches (for a covered tool). */
function coversPattern(a: PermissionRule, b: PermissionRule): boolean {
  const am = a.match ?? ''
  const bm = b.match ?? ''
  if (am === '') return false
  // A glob `*` matches anything for its tool; an exact `*` is the literal subject.
  if (!a.exact && am === '*') return true
  if (am !== bm) return false
  // The same text: an exact rule covers only an exact one (a glob of the same text
  // can match more), while a glob covers both (the literal is one of its matches).
  return !a.exact || !!b.exact
}

/** The issues for each rule, keyed by its index in `rules` (rules with none omitted). */
export function lintPermissionRules(rules: PermissionRule[]): Map<number, RuleIssue[]> {
  const out = new Map<number, RuleIssue[]>()
  const add = (i: number, issue: RuleIssue): void => {
    const list = out.get(i) ?? []
    list.push(issue)
    out.set(i, list)
  }
  rules.forEach((rule, j) => {
    if ((rule.match ?? '').trim() === '') {
      add(j, { kind: 'empty' })
      return
    }
    for (let i = 0; i < j; i++) {
      const earlier = rules[i]
      if (coversTool(earlier, rule) && coversPattern(earlier, rule)) {
        add(j, { kind: 'shadowed', by: i, conflicting: earlier.action !== rule.action })
        break
      }
    }
    if (rule.action === 'allow' && !rule.exact && rule.match === '*') add(j, { kind: 'broad-allow' })
  })
  return out
}

/** Move the rule at `from` to `to` (both indices into the current list). */
export function moveRule(rules: PermissionRule[], from: number, to: number): PermissionRule[] {
  if (from === to || from < 0 || from >= rules.length || to < 0 || to >= rules.length) return rules
  const next = rules.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
