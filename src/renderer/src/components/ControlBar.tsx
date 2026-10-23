import { APPROVAL_POLICY_LABEL, type AppSettings, type ApprovalPolicy, type SelectedModel } from '@shared/types'
import type { SubagentSpend } from '@shared/subagents'
import type { ConversationWorktree, ReasoningEffort, RepoInfo } from '@shared/agent'
import {
  contextPercent,
  resolveCapabilities,
  resolveContextWindow,
  type SessionUsage
} from '@shared/usage'
import { anthropicThinksByDefault } from '@shared/model-facts'
import { DEFAULT_REASONING_EFFORT } from '@shared/defaults'
import { Icon } from './Icon'
import { branchNameError, canCreateWorktree } from '../lib/worktree'
import { baseName } from '../lib/paths'
import { ModelPicker } from './ModelPicker'
import { CostBreakdown } from './CostBreakdown'

/** Approval-policy names, shared with the terminal so both clients say the same thing. */
export const POLICY_LABEL = APPROVAL_POLICY_LABEL

/** Provider kinds served by the Claude adapter, whose models the Claude gates describe. */
const CLAUDE_KINDS = new Set(['anthropic', 'bedrock', 'vertex', 'foundry'])

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
  onOpenSettings,
  onMakeDefault,
  subagentSpend = []
}: {
  settings: AppSettings
  selected: SelectedModel | null
  workspace: string | null
  usage: SessionUsage | null
  /** What each subagent in this chat spent, for the cost breakdown. */
  subagentSpend?: SubagentSpend[]
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
  /**
   * Make the open chat's model, reasoning effort and approval mode the defaults for
   * new chats. Set only while they differ from the defaults; the button hides otherwise.
   */
  onMakeDefault?: () => void
}): JSX.Element {
  const provider = settings.providers.find((p) => p.id === selected?.providerId)
  const needsKey = provider?.requiresKey && !provider.hasKey

  // The worktree editor only makes sense for a fresh chat in a git repo.
  const showWorktreeEditor = newChat && repoInfo?.isRepo === true
  // No commit anywhere to branch from (fresh `git init`): offer only the branch badge.
  const canWorktree = showWorktreeEditor && canCreateWorktree(repoInfo)
  const worktreeOn = canWorktree && worktreeMode
  const branchError = worktreeOn ? branchNameError(branchName, repoInfo.branches) : null

  // Always label the folder control with the repo (main worktree) name, never the
  // per-chat worktree directory — so it reads "myrepo", not "houston/feat-x".
  const repoRoot = repoInfo?.isRepo ? repoInfo.root : currentWorktree?.repoRoot
  const folderLabel = repoRoot ? baseName(repoRoot) : workspace ? baseName(workspace) : null

  // Resolve the model's context window and reasoning support from host-reported
  // metadata first (same source the model picker uses), falling back to name
  // heuristics — so the usage meter and the "Think:" control agree with the picker.
  const selectedModelOpt = provider?.models.find((m) => m.id === selected?.model)
  const ctxWindow = selected ? resolveContextWindow(selected.model, selectedModelOpt?.caps) : null
  const hasReasoning = selected
    ? resolveCapabilities(selected.model, selectedModelOpt?.caps).reasoning
    : true
  // Some Claude models reason on every request; for them "off" runs at the lowest effort.
  const alwaysThinks =
    !!selected &&
    !!provider &&
    CLAUDE_KINDS.has(provider.kind) &&
    anthropicThinksByDefault(selected.model)
  const pct = usage ? contextPercent(usage.context, ctxWindow) : null
  const meterClass = pct === null ? '' : pct >= 95 ? ' usage__fill--danger' : pct >= 80 ? ' usage__fill--warn' : ''
  // In an open chat these controls change that chat only; on the new-chat screen
  // they set what new chats start with. Said in each tooltip.
  const scope = newChat ? ' (for new chats)' : ' (this chat only)'

  return (
    <div className="control-bar">
      <button
        className="control control--ws"
        onClick={onChangeWorkspace}
        title="Change project folder"
        aria-label={folderLabel ? `Project folder: ${folderLabel}. Change` : 'Choose project folder'}
      >
        <Icon name="folder" className="control__icon" />
        <span className="control__text">{folderLabel ?? 'Choose folder…'}</span>
      </button>

      {showWorktreeEditor && (
        <div className="control-bar__wt">
          {worktreeOn ? (
            <select
              className="control control--select"
              value={baseBranch}
              title="Base the new branch on"
              aria-label="Base branch"
              onChange={(e) => onChangeBaseBranch(e.target.value)}
            >
              {/* Detached HEAD: '' means "branch from HEAD", so list it rather than
                  letting the select display a branch it won't send. */}
              {!repoInfo.currentBranch && <option value="">HEAD (detached)</option>}
              {repoInfo.currentBranch &&
                !repoInfo.unborn &&
                !repoInfo.branches.includes(repoInfo.currentBranch) && (
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
              title={`No worktree: this chat works directly on the repo's current branch, ${
                repoInfo.currentBranch ?? 'detached HEAD'
              }`}
            >
              <Icon name="gitBranch" size={13} className="control__icon" />
              <span className="control__text">
                {repoInfo.currentBranch ?? 'detached HEAD'}
                {repoInfo.unborn ? ' (no commits yet)' : ''}
              </span>
            </span>
          )}

          {canWorktree && (
            <label
              className="control control--check"
              data-tour="worktree"
              title="Run this chat in a new git worktree on its own branch (isolated from your current checkout)"
            >
              <input
                type="checkbox"
                checked={worktreeMode}
                onChange={(e) => onToggleWorktree(e.target.checked)}
              />
              <Icon name="gitBranch" size={13} className="control__icon" />
              <span>New worktree</span>
            </label>
          )}

          {worktreeOn && (
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

      {/* Where the chat runs on one row, how it runs (model, thinking, approval) on the
          next. Left to wrap freely, the row broke wherever the width ran out, often
          leaving the approval mode alone on a second line. */}
      {showWorktreeEditor && <div className="control-bar__break" aria-hidden="true" />}

      {!newChat && currentWorktree && (
        <span
          className="control control--branch"
          title={`This chat runs in a worktree on branch ${currentWorktree.branch}`}
        >
          <Icon name="gitBranch" size={13} className="control__icon" />
          <span className="control__text">{currentWorktree.branch}</span>
        </span>
      )}

      <ModelPicker settings={settings} selected={selected} onSelect={onSelectModel} />

      <select
        className="control control--select"
        value={settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT}
        disabled={!hasReasoning}
        aria-label="Reasoning effort"
        onChange={(e) => onChangeReasoning(e.target.value as ReasoningEffort)}
        title={
          !hasReasoning
            ? 'The selected model has no reasoning mode'
            : alwaysThinks
              ? `This model always reasons. Minimal runs it at the lowest effort with its reasoning hidden${scope}.`
              : `How hard the model should think before answering${scope}`
        }
      >
        {(Object.keys(REASONING_LABEL) as ReasoningEffort[]).map((r) => (
          <option key={r} value={r}>
            {r === 'off' && alwaysThinks ? 'Think: minimal' : REASONING_LABEL[r]}
          </option>
        ))}
      </select>

      <select
        className="control control--select"
        value={settings.approvalPolicy}
        aria-label="Approval mode"
        data-tour="approval"
        onChange={(e) => onChangePolicy(e.target.value as ApprovalPolicy)}
        title={`How much the agent may do without asking${scope}`}
      >
        {(Object.keys(POLICY_LABEL) as ApprovalPolicy[]).map((p) => (
          <option key={p} value={p}>
            {POLICY_LABEL[p]}
          </option>
        ))}
      </select>

      {onMakeDefault && (
        <button
          className="control"
          onClick={onMakeDefault}
          title="Start new chats with this chat's model, reasoning and approval mode. Other chats keep their own."
        >
          <span className="control__text">Use for new chats</span>
        </button>
      )}

      <div className="control-bar__spacer" />

      {needsKey && (
        <button className="control control--warn" onClick={onOpenSettings}>
          ⚠︎ Set API key
        </button>
      )}

      {usage && (usage.context > 0 || usage.output > 0) && (
        <CostBreakdown
          usage={usage}
          contextWindow={ctxWindow}
          meterPct={pct}
          meterClass={meterClass}
          agents={subagentSpend}
        />
      )}
    </div>
  )
}
