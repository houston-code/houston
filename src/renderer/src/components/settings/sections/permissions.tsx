import { useState } from 'react'
import type { PermissionRule } from '@shared/types'
import { SettingsSection } from '../fields'
import { groupPermissionRules } from '../permissionRules'
import type { SettingsCtx } from '../context'

/** The user's global permission rules: filter, tidy, and edit them per tool. */
export function PermissionRulesSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  // Permission-rule editor view state: filter text, in-flight "Clean up rules",
  // the tool for a newly-added rule, and which tool groups the user has collapsed.
  const [ruleFilter, setRuleFilter] = useState('')
  const [cleaningRules, setCleaningRules] = useState(false)
  // What the last "Clean up rules" did, so a no-op click isn't mistaken for a dead button.
  const [cleanupStatus, setCleanupStatus] = useState<string | null>(null)
  const [newRuleTool, setNewRuleTool] = useState('')
  const [collapsedRuleGroups, setCollapsedRuleGroups] = useState<Set<string>>(new Set())
  const toggleRuleGroup = (tool: string, open: boolean): void =>
    setCollapsedRuleGroups((prev) => {
      const next = new Set(prev)
      if (open) next.delete(tool)
      else next.add(tool)
      return next
    })

  const rules = settings.permissionRules ?? []
  const setRules = (next: PermissionRule[]): void =>
    setSettings((s) => ({ ...s, permissionRules: next }))
  // Default to 'ask', not 'allow': an all-approving rule shouldn't be one careless
  // click + Save away (the empty match pattern would otherwise auto-approve every
  // run_shell call). New rules are added for a specific tool (the group they land in).
  const addRuleFor = (tool: string): void =>
    setRules([...rules, { action: 'ask', tool, match: '' }])
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
  // Group rules by tool (keeping each rule's real index for patch/remove), honouring
  // the filter, then sub-group run_shell by the repo path its pattern targets (if any).
  const ruleGroups = groupPermissionRules(rules, ruleFilter)

  return (
    <SettingsSection
      title="Permissions"
      desc={
        <>
          Rules are checked before the approval policy (first match wins).{' '}
          <strong>Allow</strong> auto-approves, <strong>Deny</strong> refuses,{' '}
          <strong>Ask</strong> always prompts. The pattern is a glob over the call&apos;s
          command, path, URL, or query; an <strong>Exact</strong> rule matches only
          that one target. <strong>Always allow</strong> on a file saves an exact
          rule, as it does for a shell command holding <code>*</code> that it
          can&apos;t shorten to a prefix; on a web fetch it saves the site, and on a
          web search it allows every search. These are your global rules; a
          project&apos;s{' '}
          <code>.houston/settings.json</code> may add stricter deny/ask rules that apply
          first and aren&apos;t shown here.
        </>
      }
    >

      {rules.length > 0 && (
        <div className="rule-toolbar">
          <input
            className="rule-filter"
            placeholder="Filter rules…"
            value={ruleFilter}
            onChange={(e) => setRuleFilter(e.target.value)}
          />
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

      {rules.length > 0 && ruleGroups.length === 0 && (
        <p className="rule-empty">No rules match the filter.</p>
      )}

      {ruleGroups.map((group) => (
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
              {sub.rules.map(({ rule, index }) => (
                <div className="rule" key={index}>
                  <select
                    value={rule.action}
                    onChange={(e) =>
                      patchRule(index, {
                        action: e.target.value as PermissionRule['action']
                      })
                    }
                  >
                    <option value="allow">Allow</option>
                    <option value="ask">Ask</option>
                    <option value="deny">Deny</option>
                  </select>
                  <input
                    className="rule__match"
                    placeholder={
                      rule.exact
                        ? 'exact path, URL, query, or command'
                        : 'pattern, e.g. git * or src/**'
                    }
                    value={rule.match}
                    onChange={(e) => patchRule(index, { match: e.target.value })}
                  />
                  <label
                    className="rule__exact"
                    title="Match only this exact target: * is an ordinary character, and a folder does not cover the files inside it"
                  >
                    <input
                      type="checkbox"
                      checked={!!rule.exact}
                      onChange={(e) =>
                        patchRule(index, { exact: e.target.checked || undefined })
                      }
                    />
                    Exact
                  </label>
                  <button
                    className="btn btn--sm btn--danger"
                    onClick={() => removeRule(index)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
          <button
            className="btn btn--sm rule-group__add"
            onClick={() => addRuleFor(group.tool)}
          >
            + Add {group.tool} rule
          </button>
        </details>
      ))}

      <div className="rule-add-other">
        <input
          list="tool-names"
          className="rule__tool"
          placeholder="tool (or *)"
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
