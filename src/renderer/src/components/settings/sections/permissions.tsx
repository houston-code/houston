import { useEffect, useMemo, useState } from 'react'
import {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_LABEL,
  permissionRuleKey,
  type ApprovalPolicy,
  type PermissionRule,
  type PermissionTestResult
} from '@shared/types'
import { lintPermissionRules, moveRule, type RuleIssue } from '@shared/permissionLint'
import { SettingsSection } from '../fields'
import { ReadOnlyRules, TrustBadge } from './project'
import { groupPermissionRules, ruleMatchesFilter, TOOL_NAMES } from '../permissionRules'
import { ruleMetaText, testVerdictText } from '../ruleMeta'
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
  meta,
  hit,
  onPatch,
  onRemove
}: {
  rule: PermissionRule
  index: number
  issues: RuleIssue[]
  rules: PermissionRule[]
  showTool: boolean
  order?: RowOrder
  /** When the rule was added and last used, or ''. */
  meta: string
  /** The rule tester's call matches this rule. */
  hit: boolean
  onPatch: (patch: Partial<PermissionRule>) => void
  onRemove: () => void
}): JSX.Element {
  const n = index + 1
  const warn = issues.some(isWarning)
  return (
    <div
      className={`rule-row${warn ? ' rule-row--warn' : ''}${hit ? ' rule-row--hit' : ''}`}
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
      {meta && <p className="rule__meta">{meta}</p>}
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
  const [view, setView] = useState<'order' | 'tool' | 'sources'>('order')
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
  const addRuleFor = (tool: string): void =>
    setRules([...rules, { action: 'ask', tool, match: '', addedAt: Date.now(), source: 'settings' }])
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

  // When each rule last decided a call (recorded by the agent), for the meta line.
  const [usage, setUsage] = useState<Record<string, number>>({})
  useEffect(() => {
    let alive = true
    void window.api
      .getRuleUsage?.()
      .then((u) => {
        if (alive) setUsage(u ?? {})
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const [now] = useState(() => Date.now())
  const [tested, setTested] = useState<Set<number>>(new Set())
  const managed = ctx.policy?.managed ?? []
  const project = ctx.policy?.project ?? null
  const hasOtherSources = managed.length > 0 || project !== null
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
      meta={ruleMetaText(rule, usage[permissionRuleKey(rule)], now)}
      hit={tested.has(index)}
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
          query; an <strong>Exact</strong> rule matches only that one target. An administrator
          policy or a project&apos;s <code>.houston/settings.json</code> may add rules that are
          checked first: see <strong>All sources</strong>.
        </>
      }
    >
      {(rules.length > 0 || hasOtherSources) && (
        <div className="rule-toolbar">
          {view !== 'sources' ? (
            <input
              className="rule-filter"
              placeholder="Filter rules…"
              aria-label="Filter rules"
              value={ruleFilter}
              onChange={(e) => setRuleFilter(e.target.value)}
            />
          ) : (
            <span className="rule-toolbar__spacer" />
          )}
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
            <button
              className={`seg__btn${view === 'sources' ? ' is-active' : ''}`}
              aria-pressed={view === 'sources'}
              onClick={() => setView('sources')}
              title="Every rule that applies, from the administrator and this project too, in the order they are checked"
            >
              All sources
            </button>
          </div>
          {view !== 'sources' && (
            <>
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
            </>
          )}
        </div>
      )}
      {view === 'sources' && (
        <ol className="rule-tiers">
          {managed.length > 0 && (
            <li className="rule-tier">
              <h4 className="rule-tier__title">Administrator policy</h4>
              <p className="rule-tier__desc">Set on this device by an administrator; can only restrict.</p>
              <ReadOnlyRules rules={managed} empty="" />
            </li>
          )}
          {project && (
            <li className="rule-tier">
              <h4 className="rule-tier__title">This project&apos;s guardrails</h4>
              <p className="rule-tier__desc">
                Deny and ask rules from <code>.houston/settings.json</code>; always applied.
              </p>
              <ReadOnlyRules rules={project.rules} empty="None." />
            </li>
          )}
          <li className="rule-tier rule-tier--yours">
            <h4 className="rule-tier__title">Your rules</h4>
            <p className="rule-tier__desc">
              {rules.length} {rules.length === 1 ? 'rule' : 'rules'}.{' '}
              <button className="link" onClick={() => setView('order')}>
                Edit
              </button>
            </p>
          </li>
          {project && project.allowRules.length > 0 && (
            <li className="rule-tier">
              <h4 className="rule-tier__title">This project&apos;s allow rules</h4>
              <p className="rule-tier__desc">
                Fill gaps your rules leave; never override them. <TrustBadge trust={project.trust} />
              </p>
              <ReadOnlyRules rules={project.allowRules} empty="" />
            </li>
          )}
          <li className="rule-tier">
            <h4 className="rule-tier__title">Then the chat&apos;s approval mode</h4>
            <p className="rule-tier__desc">
              When no rule matches. New chats start in{' '}
              <strong>{APPROVAL_POLICY_LABEL[settings.approvalPolicy]}</strong>.
            </p>
          </li>
        </ol>
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

      {view !== 'sources' && rules.length > 0 && visible.length === 0 && (
        <p className="rule-empty">No rules match the filter.</p>
      )}

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

      <RuleTester ctx={ctx} rules={rules} onMatches={setTested} />

      {view !== 'sources' && (
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
      )}
    </SettingsSection>
  )
}

/** The subject a tool's rules match, as a placeholder for the tester's input. */
const SUBJECT_HINT: Record<string, string> = {
  run_shell: 'a command, e.g. git push origin main',
  web_fetch: 'a URL, e.g. https://example.com/docs',
  web_search: 'a search query'
}

/**
 * "Test a call": what the rules decide for a tool call, from the real matcher in
 * main (with the admin and project tiers), against the working copy of the rules,
 * so an edit can be checked before it is saved. Matching rows are highlighted.
 */
function RuleTester({
  ctx,
  rules,
  onMatches
}: {
  ctx: SettingsCtx
  rules: PermissionRule[]
  onMatches: (indices: Set<number>) => void
}): JSX.Element {
  const [tool, setTool] = useState('run_shell')
  const [subject, setSubject] = useState('')
  const [result, setResult] = useState<PermissionTestResult | null>(null)
  const workspace = ctx.workspace
  useEffect(() => {
    if (subject.trim() === '') {
      setResult(null)
      onMatches(new Set())
      return
    }
    let alive = true
    // Debounced: each keystroke would otherwise be a round trip to main.
    const timer = setTimeout(() => {
      void window.api
        .testPermission({ workspace, userRules: rules, tool, subject })
        .then((r) => {
          if (!alive) return
          setResult(r)
          onMatches(new Set(r.userMatches))
        })
        .catch(() => {})
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [workspace, rules, tool, subject, onMatches])

  return (
    <details className="rule-tester">
      <summary>Test a call</summary>
      <div className="rule-tester__row">
        <select aria-label="Tool to test" value={tool} onChange={(e) => setTool(e.target.value)}>
          {TOOL_NAMES.filter((t) => t !== '*').map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="rule-tester__subject"
          aria-label="Call to test"
          placeholder={SUBJECT_HINT[tool] ?? 'a path, e.g. src/index.ts'}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      {result && (
        <p className={`rule-tester__verdict rule-tester__verdict--${result.decision ?? 'none'}`} role="status">
          {testVerdictText(result, rules, ctx.settings.approvalPolicy)}
        </p>
      )}
      <p className="rule__meta">
        Rules only. A write outside the project or to a sensitive file can still ask, whatever
        the rules say.
      </p>
    </details>
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
