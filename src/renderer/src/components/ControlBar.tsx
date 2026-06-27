import type { AppSettings, ApprovalPolicy, SelectedModel } from '@shared/types'
import type { ConversationWorktree, ReasoningEffort, RepoInfo } from '@shared/agent'
import {
  contextPercent,
  contextWindowFor,
  formatTokens,
  formatUsd,
  type SessionUsage
} from '@shared/usage'
import { branchNameError } from '../lib/worktree'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

const POLICY_LABEL: Record<ApprovalPolicy, string> = {
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
  newChat,
  repoInfo,
  worktreeMode,
  branchName,
  baseBranch,
  currentWorktree,
  onToggleWorktree,
  onChangeBranchName,
  onChangeBaseBranch,
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
  /** True for a not-yet-started chat — show the editable worktree controls. */
  newChat: boolean
  /** Git info for the current workspace (drives the worktree controls), or null. */
  repoInfo: RepoInfo | null
  /** Whether the next new chat will run in a fresh worktree (default on for repos). */
  worktreeMode: boolean
  /** The new branch / worktree name to create. */
  branchName: string
  /** The base ref to branch the worktree from. */
  baseBranch: string
  /** The open conversation's worktree, shown read-only when not a new chat. */
  currentWorktree?: ConversationWorktree | null
  onToggleWorktree: (on: boolean) => void
  onChangeBranchName: (name: string) => void
  onChangeBaseBranch: (base: string) => void
  onSelectModel: (sel: SelectedModel) => void
  onChangePolicy: (p: ApprovalPolicy) => void
  onChangeReasoning: (e: ReasoningEffort) => void
  onChangeWorkspace: () => void
  onOpenSettings: () => void
}): JSX.Element {
  const provider = settings.providers.find((p) => p.id === selected?.providerId)
  const needsKey = provider?.requiresKey && !provider.hasKey
  const value = selected ? `${selected.providerId}::${selected.model}` : ''

  // The worktree editor only makes sense for a fresh chat in a git repo.
  const showWorktreeEditor = newChat && repoInfo?.isRepo === true
  const branchError = showWorktreeEditor && worktreeMode ? branchNameError(branchName, repoInfo.branches) : null

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

      {showWorktreeEditor && (
        <div className="control-bar__wt">
          <label
            className="control control--check"
            title="Run this chat in a new git worktree on its own branch (isolated from your current checkout)"
          >
            <input
              type="checkbox"
              checked={worktreeMode}
              onChange={(e) => onToggleWorktree(e.target.checked)}
            />
            <span>⑂ New worktree</span>
          </label>

          {worktreeMode && (
            <>
              <select
                className="control control--select"
                value={baseBranch}
                title="Base the new branch on"
                aria-label="Base branch"
                onChange={(e) => onChangeBaseBranch(e.target.value)}
              >
                {repoInfo.currentBranch && !repoInfo.branches.includes(repoInfo.currentBranch) && (
                  <option value={repoInfo.currentBranch}>
                    from {repoInfo.currentBranch} (current)
                  </option>
                )}
                {repoInfo.branches.map((b) => (
                  <option key={b} value={b}>
                    from {b}
                    {b === repoInfo.currentBranch ? ' (current)' : ''}
                  </option>
                ))}
              </select>

              <input
                className="control control--input"
                value={branchName}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder="new-branch-name"
                title={branchError ?? 'New branch / worktree name'}
                aria-label="New branch name"
                aria-invalid={branchError !== null}
                onChange={(e) => onChangeBranchName(e.target.value)}
              />
            </>
          )}
        </div>
      )}

      {!newChat && currentWorktree && (
        <span
          className="control control--branch"
          title={`This chat runs in a worktree on branch ${currentWorktree.branch}`}
        >
          ⑂ {currentWorktree.branch}
        </span>
      )}

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
