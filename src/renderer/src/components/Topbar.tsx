import type { AppSettings, ApprovalPolicy, SelectedModel } from '@shared/types'
import type { ReasoningEffort } from '@shared/agent'
import { formatTokens, type SessionUsage } from '@shared/usage'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

const POLICY_LABEL: Record<ApprovalPolicy, string> = {
  ask: 'Ask every time',
  'auto-edit': 'Auto-approve edits',
  'full-auto': 'Full auto'
}

const REASONING_LABEL: Record<ReasoningEffort, string> = {
  off: 'Think: off',
  low: 'Think: low',
  medium: 'Think: medium',
  high: 'Think: high'
}

export function Topbar({
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

  // Flatten providers → models into option groups.
  return (
    <header className="topbar">
      <button className="topbar__ws" onClick={onChangeWorkspace} title="Change project folder">
        📁 {workspace ? basename(workspace) : 'Choose folder…'}
      </button>

      <select
        className="topbar__select"
        value={value}
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

      {needsKey && (
        <button className="topbar__warn" onClick={onOpenSettings}>
          ⚠︎ Set API key
        </button>
      )}

      <select
        className="topbar__select topbar__select--policy"
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
        className="topbar__select topbar__select--reasoning"
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

      {usage && (usage.context > 0 || usage.output > 0) && (
        <span
          className="topbar__usage"
          title="Context tokens (last turn) · output tokens this session"
        >
          🧮 {formatTokens(usage.context)} ctx · {formatTokens(usage.output)} out
        </span>
      )}
    </header>
  )
}
