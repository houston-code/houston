import type { PermissionRule } from './types'

/**
 * Static checks over a permission-rule list, for the editors that show one (the
 * Settings rules list and its text view). A matching deny always wins, wherever it
 * sits; otherwise rules are matched top to bottom and the first matching allow or ask
 * decides (see matchRule in main/agent/permissions.ts), so the order of allow and ask
 * rules is part of their meaning. These checks only flag what is certain from the
 * rules themselves, never what depends on a particular call:
 *
 * - `empty`: a blank pattern matches nothing, so the rule never applies.
 * - `shadowed`: another rule for the same (or every) tool already matches every call
 *   this one could, because its pattern is `*` or the identical pattern (or, for a
 *   deny, a broader one, like `git push*` over `git push origin*`), and wins: a
 *   deny anywhere in the list (over an allow or ask, or an earlier deny over a later
 *   one), or an earlier allow or ask over a later allow or ask. An earlier allow or ask
 *   never shadows a later deny. The shadowed rule never decides anything. When the two
 *   disagree on the action the other one silently wins, which is the case worth
 *   warning about. A deny or ask on one file-editing tool covers the others too.
 * - `broad-allow`: an allow whose pattern is `*`, which approves every call of that
 *   tool (every tool, for tool `*`) without asking.
 */
export type RuleIssue =
  | { kind: 'empty' }
  | { kind: 'shadowed'; by: number; conflicting: boolean }
  | { kind: 'broad-allow' }

/**
 * The file-editing tools: a deny or ask rule naming one applies to them all (see
 * FILE_EDIT_TOOLS in main/agent/permissions.ts).
 */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'notebook_edit'])

/** Whether rule `a` applies to every tool rule `b` applies to. */
function coversTool(a: PermissionRule, b: PermissionRule): boolean {
  const at = a.tool || '*'
  const bt = b.tool || '*'
  if (at === '*' || at === bt) return true
  return a.action !== 'allow' && FILE_EDIT_TOOLS.has(at) && FILE_EDIT_TOOLS.has(bt)
}

/** Whether rule `a`, at index `i`, wins over rule `b`, at index `j`, where both match. */
function winsOver(a: PermissionRule, i: number, b: PermissionRule, j: number): boolean {
  if (a.action === 'deny') return b.action !== 'deny' || i < j
  return b.action !== 'deny' && i < j
}

/**
 * Whether glob `pattern` (as matchRule reads one: `*` spans anything, and a pattern
 * with no `*` also covers what follows it at a space or `/`) matches `text` taken
 * literally.
 */
function denyCoversText(pattern: string, text: string): boolean {
  if (!pattern || !text) return false
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (new RegExp(`^${pattern.split('*').map(esc).join('.*')}$`).test(text)) return true
  if (pattern.includes('*')) return false
  return text.startsWith(`${pattern} `) || text.startsWith(`${pattern}/`)
}

/** Whether rule `a` matches every subject rule `b` matches (for a covered tool). */
function coversPattern(a: PermissionRule, b: PermissionRule): boolean {
  const am = a.match ?? ''
  const bm = b.match ?? ''
  if (am === '') return false
  // A glob `*` matches anything for its tool; an exact `*` is the literal subject.
  if (!a.exact && am === '*') return true
  // A broader deny over a narrower rule (`git push*` over `git push origin*`, `docs`
  // over `docs/README.md`): the deny matches the other's pattern read as a subject.
  // Sound for the `*`-only language: the deny's literals can only meet the other's
  // literals, so each `*` of the other falls inside one of the deny's.
  if (a.action === 'deny' && !a.exact && am !== bm && denyCoversText(am.trim(), bm.trim())) return true
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
    // A deny that covers the rule is the real winner, so it is reported first.
    const covering = (i: number): boolean =>
      i !== j && winsOver(rules[i], i, rule, j) && coversTool(rules[i], rule) && coversPattern(rules[i], rule)
    const indices = rules.map((_, i) => i)
    const by =
      indices.find((i) => rules[i].action === 'deny' && covering(i)) ?? indices.find((i) => covering(i))
    if (by !== undefined) add(j, { kind: 'shadowed', by, conflicting: rules[by].action !== rule.action })
    if (rule.action === 'allow' && !rule.exact && rule.match === '*') add(j, { kind: 'broad-allow' })
  })
  return out
}

/**
 * One line of copy per lint issue, naming rules by their 1-based position. Shared by
 * the desktop's rules editor and the terminal's /permissions so both say the same.
 */
export function ruleIssueText(issue: RuleIssue, rule: PermissionRule, rules: PermissionRule[]): string {
  switch (issue.kind) {
    case 'empty':
      return 'Matches nothing until it has a pattern.'
    case 'shadowed': {
      const by = rules[issue.by]
      const named = `rule ${issue.by + 1} (${by.action} ${by.tool || '*'} ${by.match})`
      if (!issue.conflicting) return `Redundant: rule ${issue.by + 1} already covers this.`
      return by.action === 'deny'
        ? `Never applies: ${named} matches it, and a deny always wins.`
        : `Never applies: ${named} matches first.`
    }
    case 'broad-allow':
      return rule.tool === '*' || !rule.tool
        ? 'Approves every tool call without asking.'
        : `Approves every ${rule.tool} call without asking.`
  }
}

/** Whether an issue is a warning (it changes what happens) rather than a tidy-up hint. */
export function isRuleWarning(issue: RuleIssue): boolean {
  return issue.kind === 'broad-allow' || (issue.kind === 'shadowed' && issue.conflicting) || issue.kind === 'empty'
}

/** Move the rule at `from` to `to` (both indices into the current list). */
export function moveRule(rules: PermissionRule[], from: number, to: number): PermissionRule[] {
  if (from === to || from < 0 || from >= rules.length || to < 0 || to >= rules.length) return rules
  const next = rules.slice()
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
