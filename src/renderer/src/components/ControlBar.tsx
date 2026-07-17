import type { AppSettings, ApprovalPolicy, SelectedModel } from '@shared/types'
import type { ConversationWorktree, ReasoningEffort, RepoInfo } from '@shared/agent'
import {
  contextPercent,
  resolveCapabilities,
  resolveContextWindow,
  type SessionUsage
} from '@shared/usage'
import { branchNameError } from '../lib/worktree'
import { ModelPicker } from './ModelPicker'
import { CostBreakdown } from './CostBreakdown'

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

  // The worktree editor only makes sense for a fresh chat in a git repo.
  const showWorktreeEditor = newChat && repoInfo?.isRepo === true
  const branchError = showWorktreeEditor && worktreeMode ? branchNameError(branchName, repoInfo.branches) : null

  // Always label the folder control with the repo (main worktree) name, never the
  // per-chat worktree directory — so it reads "myrepo", not "houston/feat-x".
  const repoRoot = repoInfo?.isRepo ? repoInfo.root : currentWorktree?.repoRoot
  const folderLabel = repoRoot ? basename(repoRoot) : workspace ? basename(workspace) : null

  // Resolve the model's context window and reasoning support from host-reported
  // metadata first (same source the model picker uses), falling back to name
  // heuristics — so the usage meter and the "Think:" control agree with the picker.
  const selectedModelOpt = provider?.models.find((m) => m.id === selected?.model)
  const ctxWindow = selected ? resolveContextWindow(selected.model, selectedModelOpt?.caps) : null
  const hasReasoning = selected
    ? resolveCapabilities(selected.model, selectedModelOpt?.caps).reasoning
    : true
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
        <span className="control__text">{folderLabel ?? 'Choose folder…'}</span>
      </button>

      {showWorktreeEditor && (
        <div className="control-bar__wt">
          {worktreeMode ? (
            <select
              className="control control--select"
              value={baseBranch}
              title="Base the new branch on"
              aria-label="Base branch"
              onChange={(e) => onChangeBaseBranch(e.target.value)}
            >
              {repoInfo.currentBranch && !repoInfo.branches.includes(repoInfo.currentBranch) && (
                <option value={repoInfo.currentBranch}>{repoInfo.currentBranch} (current)</option>
              )}
              {repoInfo.branches.map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === repoInfo.currentBranch ? ' (current)' : ''}
                </option>
              ))}
            </select>
          ) : (
            // Worktree off → the chat works in the repo on its current branch.
            // Show it (read-only) so it's clear which branch will be touched.
            <span
              className="control control--branch"
              title="No worktree — this chat works directly on the repo's current branch"
            >
              ⑂ {repoInfo.currentBranch ?? 'detached HEAD'}
            </span>
          )}

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

      <ModelPicker settings={settings} selected={selected} onSelect={onSelectModel} />

      <select
        className="control control--select"
        value={settings.reasoningEffort ?? 'off'}
        disabled={!hasReasoning}
        aria-label="Reasoning effort"
        onChange={(e) => onChangeReasoning(e.target.value as ReasoningEffort)}
        title={
          hasReasoning
            ? 'How hard the model should think before answering'
            : 'The selected model has no reasoning mode'
        }
      >
        {(Object.keys(REASONING_LABEL) as ReasoningEffort[]).map((r) => (
          <option key={r} value={r}>
            {REASONING_LABEL[r]}
          </option>
        ))}
      </select>

      <select
        className="control control--select"
        value={settings.approvalPolicy}
        aria-label="Approval mode"
        onChange={(e) => onChangePolicy(e.target.value as ApprovalPolicy)}
        title="How much the agent may do without asking"
      >
        {(Object.keys(POLICY_LABEL) as ApprovalPolicy[]).map((p) => (
          <option key={p} value={p}>
            {POLICY_LABEL[p]}
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
        <CostBreakdown usage={usage} contextWindow={ctxWindow} meterPct={pct} meterClass={meterClass} />
      )}
    </div>
  )
}
