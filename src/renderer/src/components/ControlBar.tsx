import type { AppSettings, ApprovalPolicy, SelectedModel } from '@shared/types'
import type { ReasoningEffort } from '@shared/agent'
import {
  contextPercent,
  contextWindowFor,
  formatTokens,
  formatUsd,
  type SessionUsage
} from '@shared/usage'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

export const POLICY_LABEL: Record<ApprovalPolicy, string> = {
  plan: 'Plan mode (read-only)',
  ask: 'Ask every time',
  'auto-edit': 'Auto-approve edits',
  'full-auto': 'Full auto'
}

const REASONING_LABEL: Record<ReasoningEffort, string> = {
  off: 'Think: off',
  low: 'Think: low',
  medium: 'Think: medium',
  high: 'Think: high',
  xhigh: 'Think: xhigh'
}

/**
 * The model / project / mode controls, plus token usage. Lives in a compact bar
 * directly above the composer (moved out of the old top header).
 */
export function ControlBar({
  settings,
  selected,
  workspace,
  usage,
  onSelectModel,
  onChangePolicy,
  onChangeReasoning,
  onChangeWorkspace,
  onOpenSettings
}: {
  settings: AppSettings
  selected: SelectedModel | null
  workspace: string | null
  usage: SessionUsage | null
  onSelectModel: (sel: SelectedModel) => void
  onChangePolicy: (p: ApprovalPolicy) => void
  onChangeReasoning: (e: ReasoningEffort) => void
  onChangeWorkspace: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const provider = settings.providers.find((p) => p.id === selected?.providerId)
  const needsKey = provider?.requiresKey && !provider.hasKey
  const value = selected ? `${selected.providerId}::${selected.model}` : ''

  const ctxWindow = selected ? contextWindowFor(selected.model) : null
  const pct = usage ? contextPercent(usage.context, ctxWindow) : null
  const meterClass = pct === null ? '' : pct >= 95 ? ' usage__fill--danger' : pct >= 80 ? ' usage__fill--warn' : ''

  return (
    <div className="control-bar">
      <button
        className="control control--ws"
        onClick={onChangeWorkspace}
        title="Change project folder"
      >
        <span className="control__icon">📁</span>
        <span className="control__text">{workspace ? basename(workspace) : 'Choose folder…'}</span>
      </button>

      <select
        className="control control--select"
        value={value}
        title="Model"
        onChange={(e) => {
          const [providerId, model] = e.target.value.split('::')
          if (providerId && model) onSelectModel({ providerId, model })
        }}
      >
        <option value="" disabled>
          Select a model…
        </option>
        {settings.providers.map((p) => (
          <optgroup key={p.id} label={`${p.label}${p.requiresKey && !p.hasKey ? ' (no key)' : ''}`}>
            {p.models.length === 0 && (
              <option value="" disabled>
                — no models configured —
              </option>
            )}
            {p.models.map((m) => (
              <option key={`${p.id}::${m.id}`} value={`${p.id}::${m.id}`}>
                {m.label ?? m.id}
              </option>
            ))}
          </optgroup>
        ))}
      </select>

      <select
        className="control control--select"
        value={settings.approvalPolicy}
        onChange={(e) => onChangePolicy(e.target.value as ApprovalPolicy)}
        title="How much the agent may do without asking"
      >
        {(Object.keys(POLICY_LABEL) as ApprovalPolicy[]).map((p) => (
          <option key={p} value={p}>
            {POLICY_LABEL[p]}
          </option>
        ))}
      </select>

      <select
        className="control control--select"
        value={settings.reasoningEffort ?? 'off'}
        onChange={(e) => onChangeReasoning(e.target.value as ReasoningEffort)}
        title="How hard the model should think before answering (supported models only)"
      >
        {(Object.keys(REASONING_LABEL) as ReasoningEffort[]).map((r) => (
          <option key={r} value={r}>
            {REASONING_LABEL[r]}
          </option>
        ))}
      </select>

      <div className="control-bar__spacer" />

      {needsKey && (
        <button className="control control--warn" onClick={onOpenSettings}>
          ⚠︎ Set API key
        </button>
      )}

      {usage && (usage.context > 0 || usage.output > 0) && (
        <span
          className="usage"
          title={
            (ctxWindow
              ? `Context: ${usage.context.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${pct}%)`
              : `Context: ${usage.context.toLocaleString()} tokens`) +
            `\nOutput this conversation: ${usage.output.toLocaleString()} tokens` +
            (usage.cost > 0 ? `\nEstimated cost: ${formatUsd(usage.cost)} (approximate)` : '')
          }
        >
          {pct !== null && (
            <span className="usage__meter">
              <span className={`usage__fill${meterClass}`} style={{ width: `${pct}%` }} />
            </span>
          )}
          <span className="usage__text">
            {pct !== null
              ? `${formatTokens(usage.context)}/${formatTokens(ctxWindow!)} · ${pct}%`
              : `${formatTokens(usage.context)} ctx`}{' '}
            · {formatTokens(usage.output)} out
          </span>
        </span>
      )}
    </div>
  )
}
