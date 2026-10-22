import { useMemo, useState } from 'react'
import { APPROVAL_POLICIES, APPROVAL_POLICY_LABEL, type ApprovalPolicy, type PermissionRule } from '@shared/types'
import { lintPermissionRules, moveRule, type RuleIssue } from '@shared/permissionLint'
import { SettingsSection } from '../fields'
import { groupPermissionRules, ruleMatchesFilter } from '../permissionRules'
import type { SettingsCtx } from '../context'

/** One line of copy per lint issue, naming rules by their 1-based position. */
function issueText(issue: RuleIssue, rule: PermissionRule, rules: PermissionRule[]): string {
  switch (issue.kind) {
    case 'empty':
      return 'Matches nothing until it has a pattern.'
    case 'shadowed': {
      const by = rules[issue.by]
      return issue.conflicting
        ? `Never applies: rule ${issue.by + 1} (${by.action} ${by.tool || '*'} ${by.match}) matches first.`
        : `Redundant: rule ${issue.by + 1} already covers this.`
    }
    case 'broad-allow':
      return rule.tool === '*' || !rule.tool
        ? 'Approves every tool call without asking.'
        : `Approves every ${rule.tool} call without asking.`
  }
}

/** Whether an issue is a warning (it changes what happens) rather than a tidy-up hint. */
function isWarning(issue: RuleIssue): boolean {
  return issue.kind === 'broad-allow' || (issue.kind === 'shadowed' && issue.conflicting) || issue.kind === 'empty'
}

/** Ordering controls for a row in the ordered view; absent in the grouped view. */
interface RowOrder {
  /** The row can be reordered (false while a filter hides rows). */
  enabled: boolean
  count: number
  onMove: (to: number) => void
  onDragStart: () => void
  onDrop: () => void
}

function RuleRow({
  rule,
  index,
  issues,
  rules,
  showTool,
  order,
  onPatch,
  onRemove
}: {
  rule: PermissionRule
  index: number
  issues: RuleIssue[]
  rules: PermissionRule[]
  showTool: boolean
  order?: RowOrder
  onPatch: (patch: Partial<PermissionRule>) => void
  onRemove: () => void
}): JSX.Element {
  const n = index + 1
  const warn = issues.some(isWarning)
  return (
    <div
      className={`rule-row${warn ? ' rule-row--warn' : ''}`}
      onDragOver={order?.enabled ? (e) => e.preventDefault() : undefined}
      onDrop={
        order?.enabled
          ? (e) => {
              e.preventDefault()
              order.onDrop()
            }
          : undefined
      }
    >
      <div className="rule">
        {order && (
          <>
            <span
              className={`rule__handle${order.enabled ? '' : ' is-disabled'}`}
              draggable={order.enabled}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                // Firefox starts a drag only once data is set.
                e.dataTransfer.setData('text/plain', String(index))
                const row = e.currentTarget.closest('.rule-row')
                if (row) e.dataTransfer.setDragImage(row, 12, 12)
                order.onDragStart()
              }}
              title={order.enabled ? 'Drag to reorder' : 'Clear the filter to reorder'}
              aria-hidden="true"
            >
              ⋮⋮
            </span>
            <span className="rule__num" title="Rules are checked in this order; the first match wins">
              {n}
            </span>
          </>
        )}
        <select
          aria-label={`Rule ${n} action`}
          value={rule.action}
          onChange={(e) => onPatch({ action: e.target.value as PermissionRule['action'] })}
        >
          <option value="allow">Allow</option>
          <option value="ask">Ask</option>
          <option value="deny">Deny</option>
        </select>
        {showTool && (
          <input
            list="tool-names"
            className="rule__tool"
            aria-label={`Rule ${n} tool`}
            placeholder="tool (or *)"
            value={rule.tool}
            onChange={(e) => onPatch({ tool: e.target.value.trim() })}
          />
        )}
        <input
          className="rule__match"
          aria-label={`Rule ${n} pattern`}
          placeholder={rule.exact ? 'exact path, URL, query, or command' : 'pattern, e.g. git * or src/**'}
          value={rule.match}
          onChange={(e) => onPatch({ match: e.target.value })}
        />
        <label
          className="rule__exact"
          title="Match only this exact target: * is an ordinary character, and a folder does not cover the files inside it"
        >
          <input
            type="checkbox"
            checked={!!rule.exact}
            onChange={(e) => onPatch({ exact: e.target.checked || undefined })}
          />
          Exact
        </label>
        {order && (
          <>
            <button
              className="btn btn--sm rule__move"
              aria-label={`Move rule ${n} up`}
              title={order.enabled ? 'Move up (checked earlier)' : 'Clear the filter to reorder'}
              disabled={!order.enabled || index === 0}
              onClick={() => order.onMove(index - 1)}
            >
              ↑
            </button>
            <button
              className="btn btn--sm rule__move"
              aria-label={`Move rule ${n} down`}
              title={order.enabled ? 'Move down (checked later)' : 'Clear the filter to reorder'}
              disabled={!order.enabled || index === order.count - 1}
              onClick={() => order.onMove(index + 1)}
            >
              ↓
            </button>
          </>
        )}
        <button className="btn btn--sm btn--danger" aria-label={`Remove rule ${n}`} onClick={onRemove}>
          ✕
        </button>
      </div>
      {issues.map((issue, i) => (
        <p key={i} className={`rule__issue${isWarning(issue) ? ' rule__issue--warn' : ''}`}>
          {issueText(issue, rule, rules)}
        </p>
      ))}
    </div>
  )
}

/**
 * The user's global permission rules. The default view is the list in the order
 * the matcher reads it (first match wins), numbered and reorderable, with lint
 * notes on rules that can never apply. "By tool" groups the same rules per tool,
 * which reads better for a long list but hides the order.
 */
export function PermissionRulesSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const [view, setView] = useState<'order' | 'tool'>('order')
  const [ruleFilter, setRuleFilter] = useState('')
  const [cleaningRules, setCleaningRules] = useState(false)
  // What the last "Clean up rules" did, so a no-op click isn't mistaken for a dead button.
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null)
  const [newRuleTool, setNewRuleTool] = useState('')
  const [collapsedRuleGroups, setCollapsedRuleGroups] = useState<Set<string>>(new Set())
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const toggleRuleGroup = (tool: string, open: boolean): void =>
    setCollapsedRuleGroups((prev) => {
      const next = new Set(prev)
      if (open) next.delete(tool)
      else next.add(tool)
      return next
    })

  const rules = useMemo(() => settings.permissionRules ?? [], [settings.permissionRules])
  const setRules = (next: PermissionRule[]): void => setSettings((s) => ({ ...s, permissionRules: next }))
  // Default to 'ask', not 'allow': an all-approving rule shouldn't be one careless
  // click away (the empty match pattern would otherwise auto-approve every
  // run_shell call). New rules go last, so they never pre-empt an existing one.
  const addRuleFor = (tool: string): void => setRules([...rules, { action: 'ask', tool, match: '' }])
  const patchRule = (i: number, patch: Partial<PermissionRule>): void =>
    setRules(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const removeRule = (i: number): void => setRules(rules.filter((_, idx) => idx !== i))
  // "Clean up rules": re-generalize + dedupe via the shared main-process helper.
  const cleanupRules = async (): Promise<void> => {
    setCleaningRules(true)
    setCleanupStatus(null)
    try {
      const next = await window.api.cleanupPermissionRules(rules)
      setRules(next)
      const removed = rules.length - next.length
      setCleanupStatus(
        JSON.stringify(next) === JSON.stringify(rules)
          ? 'Rules are already tidy.'
          : removed > 0
            ? `Removed ${removed} redundant ${removed === 1 ? 'rule' : 'rules'}. Save to apply.`
            : 'Rules tidied. Save to apply.'
      )
    } catch {
      setCleanupStatus('Could not clean up rules.')
    } finally {
      setCleaningRules(false)
    }
  }

  const issues = useMemo(() => lintPermissionRules(rules), [rules])
  const warningCount = [...issues.values()].filter((list) => list.some(isWarning)).length
  const filtering = ruleFilter.trim() !== ''
  const visible = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => ruleMatchesFilter(rule, ruleFilter))
  // Group rules by tool (keeping each rule's real index for patch/remove), honouring
  // the filter, then sub-group run_shell by the repo path its pattern targets (if any).
  const ruleGroups = view === 'tool' ? groupPermissionRules(rules, ruleFilter) : []

  const row = (rule: PermissionRule, index: number, showTool: boolean, ordered: boolean): JSX.Element => (
    <RuleRow
      key={index}
      rule={rule}
      index={index}
      rules={rules}
      issues={issues.get(index) ?? []}
      showTool={showTool}
      order={
        ordered
          ? {
              enabled: !filtering,
              count: rules.length,
              onMove: (to) => setRules(moveRule(rules, index, to)),
              onDragStart: () => setDragFrom(index),
              onDrop: () => {
                if (dragFrom !== null) setRules(moveRule(rules, dragFrom, index))
                setDragFrom(null)
              }
            }
          : undefined
      }
      onPatch={(patch) => patchRule(index, patch)}
      onRemove={() => removeRule(index)}
    />
  )

  return (
    <SettingsSection
      title="Permissions"
      desc={
        <>
          Checked top to bottom before the approval mode; the first matching rule decides.{' '}
          <strong>Allow</strong> runs without asking, <strong>Ask</strong> always prompts,{' '}
          <strong>Deny</strong> refuses. A pattern is a glob over the command, path, URL, or
          query; an <strong>Exact</strong> rule matches only that one target. A project&apos;s{' '}
          <code>.houston/settings.json</code> may add stricter rules that are checked first.
        </>
      }
    >
      {rules.length > 0 && (
        <div className="rule-toolbar">
          <input
            className="rule-filter"
            placeholder="Filter rules…"
            aria-label="Filter rules"
            value={ruleFilter}
            onChange={(e) => setRuleFilter(e.target.value)}
          />
          <div className="seg" role="group" aria-label="Rule view">
            <button
              className={`seg__btn${view === 'order' ? ' is-active' : ''}`}
              aria-pressed={view === 'order'}
              onClick={() => setView('order')}
              title="In the order they are checked"
            >
              In order
            </button>
            <button
              className={`seg__btn${view === 'tool' ? ' is-active' : ''}`}
              aria-pressed={view === 'tool'}
              onClick={() => setView('tool')}
            >
              By tool
            </button>
          </div>
          <span className="rule-toolbar__count">
            {rules.length} {rules.length === 1 ? 'rule' : 'rules'}
          </span>
          <button
            className="btn btn--sm"
            onClick={cleanupRules}
            disabled={cleaningRules}
            title="Re-generalize run_shell rules and remove duplicates"
          >
            {cleaningRules ? 'Cleaning…' : 'Clean up rules'}
          </button>
        </div>
      )}
      {cleanupStatus && (
        <p className="rule-cleanup-status" role="status">
          {cleanupStatus}
        </p>
      )}
      {warningCount > 0 && (
        <p className="rule-summary rule-summary--warn" role="status">
          {warningCount === 1 ? '1 rule needs' : `${warningCount} rules need`} attention.
        </p>
      )}

      {rules.length > 0 && visible.length === 0 && <p className="rule-empty">No rules match the filter.</p>}

      {view === 'order' && visible.length > 0 && (
        <div className="rule-list">{visible.map(({ rule, index }) => row(rule, index, true, true))}</div>
      )}

      {view === 'tool' &&
        ruleGroups.map((group) => (
          <details
            className="rule-group"
            key={group.tool}
            open={!collapsedRuleGroups.has(group.tool)}
            onToggle={(e) => toggleRuleGroup(group.tool, e.currentTarget.open)}
          >
            <summary className="rule-group__head">
              <span className="rule-group__tool">{group.tool}</span>
              <span className="rule-group__count">{group.count}</span>
            </summary>
            {group.subgroups.map((sub, si) => (
              <div className="rule-subgroup" key={sub.label || si}>
                {sub.label && (
                  <div className="rule-subgroup__label" title={sub.label}>
                    {sub.label}
                  </div>
                )}
                {sub.rules.map(({ rule, index }) => row(rule, index, false, false))}
              </div>
            ))}
            <button className="btn btn--sm rule-group__add" onClick={() => addRuleFor(group.tool)}>
              + Add {group.tool} rule
            </button>
          </details>
        ))}

      <div className="rule-add-other">
        <input
          list="tool-names"
          className="rule__tool"
          placeholder="tool (or *)"
          aria-label="Tool for the new rule"
          value={newRuleTool}
          onChange={(e) => setNewRuleTool(e.target.value.trim())}
        />
        <button
          className="btn btn--sm"
          onClick={() => {
            addRuleFor(newRuleTool || 'run_shell')
            setNewRuleTool('')
          }}
        >
          + Add rule
        </button>
      </div>
    </SettingsSection>
  )
}

/** What each approval mode lets the agent do without asking. */
const APPROVAL_POLICY_HINT: Record<ApprovalPolicy, string> = {
  plan: 'Read-only: the agent researches and proposes a plan; nothing is written or run.',
  ask: 'Asks before every shell command and file write.',
  'auto-edit': 'Reads and edits files in the workspace without asking; asks before shell commands.',
  'full-auto': 'Runs everything without asking, still confined to the workspace sandbox.'
}

/** The approval mode new chats start in. */
export function ApprovalModeSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const current = settings.approvalPolicy
  return (
    <SettingsSection
      title="Approval mode"
      desc="The mode new chats start in. Each chat keeps its own: change it from the composer, with Shift+Tab, or with /approval."
    >
      <div className="choice-list" role="radiogroup" aria-label="Default approval mode">
        {APPROVAL_POLICIES.map((p) => (
          <label key={p} className={`choice${current === p ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name="approval-policy"
              value={p}
              checked={current === p}
              onChange={() => setSettings((s) => ({ ...s, approvalPolicy: p }))}
            />
            <span className="choice__text">
              <span className="choice__label">{APPROVAL_POLICY_LABEL[p]}</span>
              <span className="choice__hint">{APPROVAL_POLICY_HINT[p]}</span>
            </span>
          </label>
        ))}
      </div>
    </SettingsSection>
  )
}
