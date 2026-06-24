import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoInfo } from '@shared/agent'
import { isSafeGitRef } from '@shared/git'
import { useFocusTrap } from '../lib/useFocusTrap'

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

const ADJECTIVES = ['swift', 'bright', 'calm', 'bold', 'keen', 'brave', 'lucid', 'eager']
const NOUNS = ['otter', 'falcon', 'maple', 'comet', 'harbor', 'cedar', 'quartz', 'meadow']

/** A friendly, editable default branch name like `houston/swift-otter`. */
function suggestBranch(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)]
  return `houston/${a}-${n}`
}

/**
 * Modal for starting a new chat in its own git branch + worktree. Loads the repo's
 * branches to offer a base, validates the branch name client-side for instant
 * feedback (the main process re-validates authoritatively), and delegates creation
 * to `onCreate` — surfacing any git failure inline rather than closing.
 */
export function WorktreeDialog({
  workspace,
  onClose,
  onCreate
}: {
  workspace: string
  onClose: () => void
  onCreate: (branch: string, base: string) => Promise<void>
}): JSX.Element {
  const modalRef = useRef<HTMLDivElement>(null)
  useFocusTrap(modalRef, onClose)

  const [repo, setRepo] = useState<RepoInfo | null>(null)
  const [branch, setBranch] = useState(suggestBranch)
  const [base, setBase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.getRepoInfo(workspace).then((info) => {
      if (cancelled) return
      setRepo(info)
      // Default the base to whatever's checked out at the workspace.
      if (info.currentBranch) setBase(info.currentBranch)
    })
    return () => {
      cancelled = true
    }
  }, [workspace])

  const trimmed = branch.trim()
  const branchValid = isSafeGitRef(trimmed)
  const branchTaken = useMemo(
    () => !!repo && repo.branches.includes(trimmed),
    [repo, trimmed]
  )
  const canCreate = !busy && branchValid && !branchTaken && repo?.isRepo === true

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(trimmed, base)
      // On success the parent unmounts this dialog; no need to reset state.
    } catch (e) {
      setError((e as Error).message || 'Could not create the worktree.')
      setBusy(false)
    }
  }

  const notRepo = repo !== null && !repo.isRepo

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--sm"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="worktree-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="worktree-title">New chat in a worktree</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal__body">
          <p className="field__hint">
            Starts the chat in an isolated git worktree at{' '}
            <code>.houston/worktrees/…</code> inside{' '}
            <strong>{repo ? basename(repo.root) : basename(workspace)}</strong>, on a new
            branch — so the agent's edits don't touch your current checkout.
          </p>

          {notRepo ? (
            <p className="field__hint field__hint--warn">
              This folder isn't inside a git repository, so a worktree can't be created.
            </p>
          ) : (
            <>
              <label className="field">
                <span>New branch name</span>
                <input
                  value={branch}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => setBranch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submit()
                  }}
                  aria-invalid={!branchValid || branchTaken}
                />
              </label>
              {trimmed && !branchValid && (
                <p className="field__hint field__hint--warn">
                  Use letters, numbers, and <code>. _ / -</code> (must not start with a dash).
                </p>
              )}
              {branchValid && branchTaken && (
                <p className="field__hint field__hint--warn">
                  A branch named “{trimmed}” already exists. Pick another name.
                </p>
              )}

              <label className="field">
                <span>Base it on</span>
                <select value={base} onChange={(e) => setBase(e.target.value)}>
                  {!repo && <option value="">Loading…</option>}
                  {repo?.currentBranch && !repo.branches.includes(repo.currentBranch) && (
                    <option value={repo.currentBranch}>{repo.currentBranch} (current)</option>
                  )}
                  {repo?.branches.map((b) => (
                    <option key={b} value={b}>
                      {b}
                      {b === repo.currentBranch ? ' (current)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {error && <p className="field__hint field__hint--warn">{error}</p>}
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn--accent" onClick={() => void submit()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create & start'}
          </button>
        </div>
      </div>
    </div>
  )
}
