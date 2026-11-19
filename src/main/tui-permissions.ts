import {
  permissionRuleKey,
  removeFolderTrust,
  type AppSettings,
  type FolderTrustState,
  type PermissionPolicyView,
  type PermissionRule,
  type RecentDenial
} from '@shared/types'
import { isRuleWarning, lintPermissionRules, ruleIssueText } from '@shared/permissionLint'
import { parseRulesText } from '@shared/permissionRulesText'
import type { Painter } from './tui'
import { stripControlChars, terminalText } from './tui-wrap'
import { renderRecentDenials } from './tui-sessions'

/**
 * /permissions and /trust in the terminal: the desktop's Settings > Permissions and
 * Trusted folders pages. Every tier the agent's gate reads is shown (the
 * administrator's and the project's rules read-only, labeled), the user's own rules
 * carry the same lint notes and last-used time the desktop shows, and a rule added
 * here passes the same validation as the desktop's rules editor. The calls denied at a
 * prompt this session are listed too, and `/permissions allow <n>` saves the rule
 * "Always allow" would have saved for one.
 */

export type PermissionsOp =
  | { op: 'list' }
  | { op: 'remove'; index: number }
  | { op: 'allow'; index: number }
  | { op: 'add'; rule: PermissionRule }
  | { op: 'usage'; error?: string }

export const PERMISSIONS_USAGE =
  'usage: /permissions   ·   /permissions add allow|ask|deny <tool> <pattern> [--exact]   ·   /permissions remove <n>   ·   /permissions allow <n> (a recent denial)'

/** Parse the argument of /permissions. Bare command → list. */
export function parsePermissionsArgs(arg: string): PermissionsOp {
  const words = arg.trim().split(/\s+/).filter(Boolean)
  const [verb, ...rest] = words
  if (!verb || verb.toLowerCase() === 'list') return { op: 'list' }
  const v = verb.toLowerCase()
  if (v === 'remove' || v === 'rm' || v === 'delete') {
    const n = Number(rest[0])
    return rest.length === 1 && /^\d+$/.test(rest[0]) && n >= 1 ? { op: 'remove', index: n } : { op: 'usage' }
  }
  if (v === 'allow' && rest.length === 1) {
    const n = Number(rest[0])
    return /^\d+$/.test(rest[0]) && n >= 1 ? { op: 'allow', index: n } : { op: 'usage' }
  }
  if (v === 'add') {
    const exact = rest.includes('--exact')
    const [action, tool, ...pattern] = rest.filter((w) => w !== '--exact')
    if (!action || !tool || !pattern.length) {
      return { op: 'usage', error: 'a rule needs an action, a tool (or *), and a pattern' }
    }
    // The desktop editor's validation, word for word: the same parser its text view uses.
    const raw = { action: action.toLowerCase(), tool, match: pattern.join(' '), ...(exact ? { exact: true } : {}) }
    const parsed = parseRulesText(JSON.stringify([raw]))
    if (!parsed.ok) return { op: 'usage', error: parsed.error.replace(/^Rule 1 /, 'The rule ') }
    return { op: 'add', rule: parsed.rules[0] }
  }
  return { op: 'usage' }
}

export interface PermissionsCommandDeps {
  getSettings: () => AppSettings
  updateSettings?: (patch: Partial<AppSettings>) => void
  readLine: (prompt: string, opts?: { discardPending?: boolean }) => Promise<string | null>
  /** The administrator's and this folder's rules, as the desktop's Permissions page reads them. */
  policy?: () => Promise<PermissionPolicyView>
  /** When each rule last decided a call, keyed by permissionRuleKey. */
  ruleUsage?: () => Record<string, number>
  now?: () => number
  /** The calls denied at an approval prompt this session, newest first. */
  recentDenials?: () => RecentDenial[]
  /**
   * Save the allow rules "Always allow" would have saved for a recent denial (by its id),
   * and drop it from the list. Null when it is no longer listed. `deniedByRule` says a
   * saved deny rule still matches it, which wins over any allow.
   */
  allowRecentDenial?: (id: string) => { added: PermissionRule[]; deniedByRule: boolean } | null
  /** Terminal width, for fitting the recent denials. */
  width?: number
  out: (text: string) => void
}

const clean = (s: string): string => stripControlChars(s)
const TONE = { allow: 'green', deny: 'red', ask: 'yellow' } as const

/** "today", "yesterday", "3 days ago", "5 weeks ago". */
function daysAgo(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 14) return `${days} days ago`
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`
  return `${Math.floor(days / 30)} months ago`
}

/** One rule as a line: action, tool, pattern. */
function ruleLine(r: PermissionRule, paint: Painter, width: number): string {
  const tool = clean(r.tool || '*')
  const subject = r.match ? clean(r.match) : paint('(nothing)', 'dim')
  return `${paint(r.action.padEnd(5), TONE[r.action])} ${tool.padEnd(width)}  ${subject}${r.exact ? paint('  (exact)', 'dim') : ''}`
}

/** When a user rule was added and last used, as the desktop's rule meta line says it. */
function ruleMeta(r: PermissionRule, lastUsed: number | undefined, now: number): string {
  const parts: string[] = []
  if (typeof r.addedAt === 'number') {
    const how = r.source === 'prompt' ? ' from an approval prompt' : r.source === 'settings' ? ' in Settings' : ''
    parts.push(`added ${daysAgo(r.addedAt, now)}${how}`)
  }
  if (typeof lastUsed === 'number') parts.push(`last used ${daysAgo(lastUsed, now)}`)
  else if (typeof r.addedAt === 'number') parts.push('not used yet')
  return parts.join(', ')
}

const TRUST_LABEL: Record<FolderTrustState | 'none', string> = {
  trusted: 'trusted, so they apply',
  untrusted: 'never trusted, so they are ignored',
  undecided: 'not trusted yet, so they are off (/trust)',
  changed: 'changed since you trusted it, so they are off (/trust)',
  none: 'off'
}

/**
 * Every tier in the order the gate reads them: administrator, project guardrails,
 * the user's own numbered rules (with lint notes and usage), then a project's allow
 * rules. Only the user's rules are numbered, since only they can be changed here.
 */
export function renderPermissionsView(
  rules: PermissionRule[],
  policy: PermissionPolicyView | null,
  usage: Record<string, number>,
  paint: Painter,
  now: number
): string {
  const managed = policy?.managed ?? []
  const project = policy?.project ?? null
  const all = [...managed, ...(project?.rules ?? []), ...rules, ...(project?.allowRules ?? [])]
  const width = Math.max(1, ...all.map((r) => clean(r.tool || '*').length))
  const lines: string[] = [paint('Permission rules, in the order they are checked (a matching deny always wins):', 'bold')]
  const readOnly = (title: string, list: PermissionRule[]): void => {
    if (!list.length) return
    lines.push(paint(title, 'bold'))
    for (const r of list) lines.push(`      ${ruleLine(r, paint, width)}`)
  }
  readOnly('  Administrator policy (read-only):', managed)
  readOnly("  This project's guardrails, .houston/settings.json (read-only):", project?.rules ?? [])

  lines.push(paint('  Your rules:', 'bold'))
  if (!rules.length) {
    lines.push(paint('      none yet. "Always allow" or "Always deny" at an approval saves one, or /permissions add.', 'dim'))
  }
  const issues = lintPermissionRules(rules)
  let warnings = 0
  rules.forEach((r, i) => {
    lines.push(`  ${paint(String(i + 1).padStart(3), 'cyan')}. ${ruleLine(r, paint, width)}`)
    const meta = ruleMeta(r, usage[permissionRuleKey(r)], now)
    if (meta) lines.push(paint(`        ${meta}`, 'dim'))
    const list = issues.get(i) ?? []
    if (list.some(isRuleWarning)) warnings++
    for (const issue of list) {
      const text = clean(ruleIssueText(issue, r, rules))
      lines.push(isRuleWarning(issue) ? paint(`        ! ${text}`, 'yellow') : paint(`        ${text}`, 'dim'))
    }
  })

  if (project && project.allowRules.length) {
    readOnly(`  This project's allow rules (read-only; ${TRUST_LABEL[project.trust]}):`, project.allowRules)
  }
  lines.push(paint('  Then the chat\'s approval mode decides.', 'dim'))
  if (warnings) lines.push(paint(`· ${warnings === 1 ? '1 rule needs' : `${warnings} rules need`} attention`, 'yellow'))
  lines.push(paint(PERMISSIONS_USAGE.replace('usage: ', ''), 'dim'))
  return lines.join('\n')
}

const isYes = (answer: string | null): boolean => /^\s*y(es)?\s*$/i.test(answer ?? '')

/** Run a parsed /permissions. */
export async function runPermissionsCommand(
  op: PermissionsOp,
  deps: PermissionsCommandDeps,
  paint: Painter
): Promise<void> {
  const now = deps.now?.() ?? Date.now()
  const rules = deps.getSettings().permissionRules ?? []
  if (op.op === 'usage') {
    return void deps.out(paint(`· ${op.error ? `${clean(op.error)}. ` : ''}${PERMISSIONS_USAGE}\n`, op.error ? 'yellow' : 'dim'))
  }
  if (op.op === 'list') {
    // An unreadable policy or usage file reads as absent, as the agent's gate treats it.
    const policy: PermissionPolicyView | null = await Promise.resolve()
      .then(() => deps.policy?.())
      .then(
        (p) => p ?? null,
        () => null
      )
    let usage: Record<string, number>
    try {
      usage = deps.ruleUsage?.() ?? {}
    } catch {
      usage = {}
    }
    deps.out(`${renderPermissionsView(rules, policy, usage, paint, now)}\n`)
    const recent = renderRecentDenials(deps.recentDenials?.() ?? [], paint, now, deps.width)
    if (recent) deps.out(`${recent}\n`)
    return
  }
  if (op.op === 'allow') {
    const denial = (deps.recentDenials?.() ?? [])[op.index - 1]
    if (!denial) return void deps.out(paint(`· no recently denied call ${op.index}; /permissions lists them\n`, 'yellow'))
    const saved = deps.allowRecentDenial?.(denial.id)
    if (!saved) return void deps.out(paint('· saving rules is unavailable here\n', 'dim'))
    const ruleText = (r: PermissionRule): string =>
      `${r.action} ${clean(r.tool || '*')} ${terminalText(r.match, { lines: false })}${r.exact ? ' (exact)' : ''}`
    deps.out(
      paint(
        saved.added.length
          ? `· saved: ${saved.added.map(ruleText).join('; ')}\n`
          : '· nothing to save: your rules already allow it, or it names nothing a rule can match\n',
        'dim'
      )
    )
    if (saved.deniedByRule) {
      deps.out(paint('· a deny rule still matches it, and a deny always wins: /permissions remove <n> drops that rule\n', 'yellow'))
    }
    return
  }
  if (!deps.updateSettings) return void deps.out(paint('· editing settings is unavailable here\n', 'dim'))
  if (op.op === 'remove') {
    const rule = rules[op.index - 1]
    if (!rule) return void deps.out(paint(`· no rule ${op.index}; /permissions lists them\n`, 'yellow'))
    deps.updateSettings({ permissionRules: rules.filter((_, i) => i !== op.index - 1) })
    const width = clean(rule.tool || '*').length
    return void deps.out(paint(`· removed: ${stripAnsiFree(ruleLine(rule, (s) => s, width))}\n`, 'dim'))
  }

  // op === 'add': last in the list, like the desktop's "+ Add rule", so it never
  // pre-empts a rule already there.
  const rule: PermissionRule = { ...op.rule, addedAt: now, source: 'settings' }
  const next = [...rules, rule]
  const issues = lintPermissionRules(next).get(next.length - 1) ?? []
  const width = clean(rule.tool || '*').length
  deps.out(`${paint('rule:', 'dim')} ${ruleLine(rule, paint, width)}\n`)
  for (const issue of issues) {
    const text = clean(ruleIssueText(issue, rule, next))
    deps.out(isRuleWarning(issue) ? paint(`  ! ${text}\n`, 'yellow') : paint(`  ${text}\n`, 'dim'))
  }
  // An allow that approves every call deserves a second look before it is saved.
  if (issues.some((i) => i.kind === 'broad-allow')) {
    const ok = await deps.readLine('Save a rule that approves every call without asking? [y/N] ', { discardPending: true })
    if (!isYes(ok)) return void deps.out(paint('· not saved\n', 'dim'))
  }
  // Read again after the question: a rule saved meanwhile (another window) stays.
  const saved = [...(deps.getSettings().permissionRules ?? []), rule]
  deps.updateSettings({ permissionRules: saved })
  deps.out(paint(`· added as rule ${saved.length}. Applies from the next tool call.\n`, 'dim'))
}

/** A rule line built with a plain painter has no escapes to strip; kept explicit for the removal note. */
function stripAnsiFree(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// --- /trust list | forget <n> ------------------------------------------------

/** Every trusted-folder decision, numbered for `/trust forget <n>`. */
export function renderTrustList(settings: AppSettings, paint: Painter): string {
  const records = settings.trustedFolders ?? []
  if (!records.length) {
    return paint("· no folder decisions yet. You're asked when a project requests extra permissions.", 'dim')
  }
  const lines = [paint('Folders whose extra permissions you decided on:', 'bold')]
  records.forEach((r, i) => {
    const label = r.decision === 'trusted' ? paint('trusted', 'green') : paint('never  ', 'yellow')
    const date = new Date(r.decidedAt).toLocaleDateString()
    lines.push(`  ${paint(String(i + 1).padStart(2), 'cyan')}. ${label}  ${clean(r.path)}  ${paint(date, 'dim')}`)
  })
  lines.push(paint('/trust forget <n> clears one; that folder asks again the next time it is open.', 'dim'))
  return lines.join('\n')
}

/** Forget the n-th decision (as /trust list numbers them). */
export function forgetTrustAt(
  index: number,
  deps: Pick<PermissionsCommandDeps, 'getSettings' | 'updateSettings' | 'out'>,
  paint: Painter
): void {
  const settings = deps.getSettings()
  const rec = (settings.trustedFolders ?? [])[index - 1]
  if (!rec) return void deps.out(paint(`· no decision ${index}; /trust list shows them\n`, 'yellow'))
  if (!deps.updateSettings) return void deps.out(paint('· editing settings is unavailable here\n', 'dim'))
  deps.updateSettings({ trustedFolders: removeFolderTrust(settings.trustedFolders, rec.path) })
  deps.out(paint(`· forgot the decision for ${clean(rec.path)}; it asks again the next time it is open\n`, 'dim'))
}
