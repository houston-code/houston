import type { PermissionRule } from '@shared/types'

/** Tool names offered as autocomplete in the permission-rule editor. */
export const TOOL_NAMES = [
  '*',
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'search_files',
  'run_shell',
  'web_fetch',
  'web_search'
]

/** A permission rule kept alongside its real index in `settings.permissionRules`. */
export interface IndexedRule {
  rule: PermissionRule
  index: number
}
export interface RuleSubgroup {
  label: string
  rules: IndexedRule[]
}
export interface RuleGroup {
  tool: string
  count: number
  subgroups: RuleSubgroup[]
}

/** Whether a rule matches the free-text filter (tool, pattern, or action substring). */
export function ruleMatchesFilter(rule: PermissionRule, filter: string): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  return (
    rule.tool.toLowerCase().includes(q) ||
    (rule.match ?? '').toLowerCase().includes(q) ||
    rule.action.includes(q)
  )
}

/** The first repo-ish absolute/home path a run_shell pattern targets, or null. */
function shellRuleRoot(match: string): string | null {
  const m = /(?:^|[\s"'([{])((?:\/|~\/)[^\s"'|&;)}\]]+)/.exec(match)
  return m ? m[1] : null
}

/** Order tools by their position in TOOL_NAMES, then unknown tools alphabetically. */
function toolOrder(tool: string): number {
  const i = TOOL_NAMES.indexOf(tool)
  return i === -1 ? TOOL_NAMES.length : i
}

/**
 * Group permission rules by tool (each keeps its real array index for editing) after
 * applying the filter. The run_shell group is further split by the repo path a rule's
 * pattern targets, so a pile of legacy `cd /repo && …` rules clusters per repo; a group
 * with a single bucket renders flat.
 */
export function groupPermissionRules(rules: PermissionRule[], filter: string): RuleGroup[] {
  const byTool = new Map<string, IndexedRule[]>()
  rules.forEach((rule, index) => {
    if (!ruleMatchesFilter(rule, filter)) return
    const tool = rule.tool || '*'
    const list = byTool.get(tool) ?? []
    list.push({ rule, index })
    byTool.set(tool, list)
  })
  const groups: RuleGroup[] = []
  for (const [tool, list] of byTool) {
    let subgroups: RuleSubgroup[] = [{ label: '', rules: list }]
    if (tool === 'run_shell') {
      const bySub = new Map<string, IndexedRule[]>()
      for (const ir of list) {
        const label = shellRuleRoot(ir.rule.match ?? '') ?? 'Commands'
        const arr = bySub.get(label) ?? []
        arr.push(ir)
        bySub.set(label, arr)
      }
      if (bySub.size > 1) subgroups = [...bySub.entries()].map(([label, r]) => ({ label, rules: r }))
    }
    groups.push({ tool, count: list.length, subgroups })
  }
  return groups.sort((a, b) => toolOrder(a.tool) - toolOrder(b.tool) || a.tool.localeCompare(b.tool))
}
