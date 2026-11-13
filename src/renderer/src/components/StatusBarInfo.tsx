import { APPROVAL_POLICY_LABEL, type ApprovalPolicy } from '@shared/types'
import { Icon } from './Icon'

/**
 * The status bar's quiet facts about where and how the chat runs: the git branch its
 * folder has checked out (worktree or not) and the approval mode in force. Read-only:
 * the controls that change them live in the control bar.
 */
export function StatusBarInfo({
  branch,
  policy
}: {
  /** A branch name; null for a repo with none checked out; undefined outside a repo. */
  branch: string | null | undefined
  policy: ApprovalPolicy | null
}): JSX.Element {
  return (
    <>
      {branch !== undefined && (
        <span
          className="statusbar__branch"
          title={
            branch === null
              ? 'No branch checked out: HEAD is detached, or the repository has no commits yet'
              : `Git branch: ${branch}`
          }
        >
          <Icon name="gitBranch" size={11} className="statusbar__icon" />
          <span className="statusbar__branch-name">{branch ?? 'No branch'}</span>
        </span>
      )}
      {policy && (
        <span className="statusbar__mode" title="Approval mode: how much the agent may do without asking">
          {APPROVAL_POLICY_LABEL[policy]}
        </span>
      )}
    </>
  )
}
