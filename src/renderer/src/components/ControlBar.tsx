import { useRef, useState } from 'react'
import {
  APPROVAL_POLICIES,
  APPROVAL_POLICY_HINT,
  APPROVAL_POLICY_LABEL,
  type AppSettings,
  type ApprovalPolicy,
  type SandboxStatus,
  type SelectedModel
} from '@shared/types'
import type { SubagentSpend } from '@shared/subagents'
import { REASONING_EFFORTS, type ConversationWorktree, type ReasoningEffort, type RepoInfo } from '@shared/agent'
import {
  contextPercent,
  resolveCapabilities,
  longContextTierAbove,
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
import { compactionLimitFrom, compactionThresholdNote } from '@shared/compactionThreshold'
import { ChoiceMenu, type Choice } from './ChoiceMenu'
import { Popover } from './Popover'
import { recentFolders } from '../lib/recentFolders'

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

/** What each effort level trades, shown under its name in the picker. */
const REASONING_HINT: Record<ReasoningEffort, string> = {
  off: 'No extra thinking. Fastest and cheapest; best for simple edits and questions.',
  low: 'A little thinking. Quick, for routine changes.',
  medium: 'Balanced speed and care.',
  high: 'Thinks carefully before acting. Slower and costs more; best for real work.',
  xhigh: 'Maximum effort, for the hardest problems. Slowest and most expensive.'
}

const POLICY_CHOICES: Choice<ApprovalPolicy>[] = APPROVAL_POLICIES.map((p) => ({
  value: p,
  label: APPROVAL_POLICY_LABEL[p],
  hint: APPROVAL_POLICY_HINT[p]
}))

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
  onOpenWorkspace,
  onOpenSettings,
  onMakeDefault,
  sandbox = null,
  subagentSpend = [],
  usageOpenSignal = 0
}: {
  settings: AppSettings
  selected: SelectedModel | null
  workspace: string | null
  usage: SessionUsage | null
  /** What each subagent in this chat spent, for the cost breakdown. */
  subagentSpend?: SubagentSpend[]
  /** Bumped to open the usage panel (what fills the context), for `/context`. */
  usageOpenSignal?: number
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
  /**
   * Open a recent folder. When set and there are recent folders, the folder button
   * opens a small menu of them plus "Choose folder…"; without recents it opens the
   * picker directly, as before.
   */
  onOpenWorkspace?: (path: string) => void
  onOpenSettings: () => void
  /**
   * Make the open chat's model, reasoning effort and approval mode the defaults for
   * new chats. Set only while they differ from the defaults; the button hides otherwise.
   */
  onMakeDefault?: () => void
  /** Whether shell commands run confined on this host; null until known (no badge). */
  sandbox?: SandboxStatus | null
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
  const priceTier = selected ? longContextTierAbove(selected.model, selectedModelOpt?.caps) : null
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
  const reasoningChoices: Choice<ReasoningEffort>[] = REASONING_EFFORTS.map((r) => ({
    value: r,
    label: r === 'off' && alwaysThinks ? 'Think: minimal' : REASONING_LABEL[r],
    hint:
      r === 'off' && alwaysThinks
        ? 'This model always reasons; this runs it at its lowest effort with the reasoning hidden.'
        : REASONING_HINT[r]
  }))

  return (
    <div className="control-bar">
      {/* Where the chat runs (folder, worktree, branch) and how it runs (model,
          thinking, approval) are two groups that each wrap as a unit. With room they
          share one row; without, the "how" group moves down whole instead of leaving
          the approval mode alone on a second line. */}
      <div className="control-bar__group">
        <FolderButton
          label={folderLabel}
          recents={onOpenWorkspace ? recentFolders(settings.recentWorkspaces, workspace) : []}
          onChoose={onChangeWorkspace}
          onOpen={(path) => onOpenWorkspace?.(path)}
        />

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
              // The toggle and the name it creates share one box: the name exists only
              // while the toggle is on, so it reads as part of it, not a separate setting.
              <span className="control-group" role="group" aria-label="New worktree">
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
              </span>
            )}
          </div>
        )}

        {!newChat && currentWorktree && (
          <span
            className="control control--branch"
            title={`This chat runs in a worktree on branch ${currentWorktree.branch}`}
          >
            <Icon name="gitBranch" size={13} className="control__icon" />
            <span className="control__text">{currentWorktree.branch}</span>
          </span>
        )}
      </div>

      <div className="control-bar__group">
        <ModelPicker settings={settings} selected={selected} onSelect={onSelectModel} />

        <ChoiceMenu
          value={settings.reasoningEffort ?? DEFAULT_REASONING_EFFORT}
          choices={reasoningChoices}
          disabled={!hasReasoning}
          ariaLabel="Reasoning effort"
          onChange={onChangeReasoning}
          title={
            !hasReasoning
              ? 'The selected model has no reasoning mode'
              : alwaysThinks
                ? `This model always reasons. Minimal runs it at the lowest effort with its reasoning hidden${scope}.`
                : `How hard the model should think before answering${scope}`
          }
        />

        <ChoiceMenu
          value={settings.approvalPolicy}
          choices={POLICY_CHOICES}
          ariaLabel="Approval mode"
          tourId="approval"
          onChange={onChangePolicy}
          title={`How much the agent may do without asking${scope}`}
        />

        {sandbox && (
          <span
            className={`control control--sandbox${sandbox.enforced ? '' : ' control--sandbox-off'}`}
            role="status"
            title={
              sandbox.enforced
                ? `Shell commands run inside the operating system sandbox (${sandbox.backend}): they can write only to this project and reach only allowed sites.`
                : 'This computer has no sandbox Houston can use, so shell commands are not confined. Houston asks before running them.'
            }
          >
            <Icon name={sandbox.enforced ? 'shield' : 'warning'} size={13} className="control__icon" />
            <span className="control__text">{sandbox.enforced ? 'Sandboxed' : 'No sandbox'}</span>
          </span>
        )}

        {onMakeDefault && (
          <button
            className="control"
            onClick={onMakeDefault}
            title="Start new chats with this chat's model, reasoning and approval mode. Other chats keep their own."
          >
            <span className="control__text">Use for new chats</span>
          </button>
        )}
      </div>

      <div className="control-bar__spacer" />

      {needsKey && (
        <button className="control control--warn" onClick={onOpenSettings}>
          ⚠︎ Set API key
        </button>
      )}

      {worktreeOn && settings.newChatWorktree === undefined && (
        <p className="control-bar__note" role="note">
          This chat will work on its own branch in a separate folder, so your checkout stays as
          it is. Untick &ldquo;New worktree&rdquo; to work in the folder directly. Houston
          remembers your choice.
        </p>
      )}

      {usage && (usage.context > 0 || usage.output > 0) && (
        <CostBreakdown
          usage={usage}
          contextWindow={ctxWindow}
          priceTierAbove={priceTier}
          compactionNote={compactionThresholdNote(compactionLimitFrom(settings), ctxWindow, priceTier)}
          meterPct={pct}
          meterClass={meterClass}
          agents={subagentSpend}
          openSignal={usageOpenSignal}
        />
      )}
    </div>
  )
}

/**
 * The project-folder control. With recent folders it opens a short menu of them plus
 * "Choose folder…"; with none it goes straight to the folder picker.
 */
function FolderButton({
  label,
  recents,
  onChoose,
  onOpen
}: {
  label: string | null
  recents: ReturnType<typeof recentFolders>
  onChoose: () => void
  onOpen: (path: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const hasMenu = recents.length > 0
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="control control--ws"
        onClick={() => (hasMenu ? setOpen((o) => !o) : onChoose())}
        title="Change project folder"
        aria-label={label ? `Project folder: ${label}. Change` : 'Choose project folder'}
        {...(hasMenu ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': open } : {})}
      >
        <Icon name="folder" className="control__icon" />
        <span className="control__text">{label ?? 'Choose folder…'}</span>
      </button>
      {open && (
        <Popover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          align="left"
          className="menu folder-menu"
          role="menu"
          ariaLabel="Project folder"
        >
          <div className="menu__label" aria-hidden="true">
            Recent folders
          </div>
          {recents.map((r) => (
            <button
              key={r.path}
              type="button"
              role="menuitem"
              className="menu__item folder-menu__item"
              title={r.path}
              onClick={() => {
                setOpen(false)
                onOpen(r.path)
              }}
            >
              <span className="folder-menu__name">{r.name}</span>
              <span className="folder-menu__where">{r.where}</span>
            </button>
          ))}
          <div className="menu__sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => {
              setOpen(false)
              onChoose()
            }}
          >
            Choose folder…
          </button>
        </Popover>
      )}
    </>
  )
}
