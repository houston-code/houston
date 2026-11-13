import { useCallback, useEffect, useState } from 'react'
import type { BranchSync } from '@shared/gitActions'

/**
 * Commit and push from the Changes view without spending an agent turn. The message
 * box takes a "Suggest message" from the chat's model (a small side request, like a
 * chat title); Commit stages every change and commits it; Push sends the branch to
 * its upstream, or publishes it on a first push. Git runs in the main process with
 * repository hooks off (see agent/gitActions.ts). Creating a pull request stays the
 * agent's job (the Create PR button).
 */
export function CommitForm({
  workspace,
  conversationId = null,
  hasChanges,
  busy = false,
  onChanged
}: {
  workspace: string
  /** The open chat, whose model suggests the message; null in a new chat. */
  conversationId?: string | null
  /** There are uncommitted changes to commit. */
  hasChanges: boolean
  /** A run is going: committing under it would race its edits. */
  busy?: boolean
  /** A commit or push changed the repository; reload whatever shows it. */
  onChanged: () => void
}): JSX.Element | null {
  const [message, setMessage] = useState('')
  const [sync, setSync] = useState<BranchSync | null>(null)
  const [working, setWorking] = useState<'suggest' | 'commit' | 'push' | null>(null)
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null)

  const loadSync = useCallback(async () => {
    try {
      setSync(await window.api.gitBranchSync(workspace))
    } catch {
      setSync(null)
    }
  }, [workspace])
  useEffect(() => {
    void loadSync()
  }, [loadSync, hasChanges])

  const suggest = async (): Promise<void> => {
    setWorking('suggest')
    setStatus(null)
    try {
      const r = await window.api.gitSuggestMessage(workspace, conversationId)
      if (r.ok && r.detail) setMessage(r.detail)
      else if (!r.ok) setStatus({ text: r.error, error: true })
    } finally {
      setWorking(null)
    }
  }
  const commit = async (): Promise<void> => {
    setWorking('commit')
    setStatus(null)
    try {
      const r = await window.api.gitCommit(workspace, message)
      if (r.ok) {
        setMessage('')
        setStatus({ text: r.detail ? `Committed ${r.detail}.` : 'Committed.', error: false })
        onChanged()
        await loadSync()
      } else setStatus({ text: r.error, error: true })
    } finally {
      setWorking(null)
    }
  }
  const push = async (): Promise<void> => {
    setWorking('push')
    setStatus(null)
    try {
      const r = await window.api.gitPush(workspace)
      if (r.ok) {
        setStatus({ text: r.detail ? `Pushed to ${r.detail}.` : 'Pushed.', error: false })
        onChanged()
        await loadSync()
      } else setStatus({ text: r.error, error: true })
    } finally {
      setWorking(null)
    }
  }

  const canPush = Boolean(sync?.branch && (sync.upstream ? sync.ahead > 0 : sync.remote && sync.ahead > 0))
  if (!hasChanges && !canPush && !status) return null
  const pushLabel = !sync?.upstream
    ? 'Publish branch'
    : `Push ${sync.ahead} commit${sync.ahead === 1 ? '' : 's'}`
  const pushTitle = !sync?.upstream
    ? `Push ${sync?.branch ?? 'this branch'} to ${sync?.remote ?? 'the remote'} for the first time`
    : `Push ${sync.branch} to ${sync.upstream}`
  const idle = working === null && !busy

  return (
    <div className="commit-form">
      {hasChanges && (
        <>
          <textarea
            className="commit-form__message"
            value={message}
            rows={2}
            aria-label="Commit message"
            placeholder="Commit message"
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && idle && message.trim()) {
                e.preventDefault()
                void commit()
              }
            }}
          />
          <div className="commit-form__row">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void suggest()}
              disabled={!idle}
              title="Ask the chat's model to describe these changes"
            >
              {working === 'suggest' ? 'Suggesting…' : 'Suggest message'}
            </button>
            <span className="commit-form__spacer" />
            <button
              type="button"
              className="btn btn--sm btn--accent"
              onClick={() => void commit()}
              disabled={!idle || !message.trim()}
              title={busy ? 'Wait for the current run to finish' : 'Stage every change and commit it (repository hooks do not run)'}
            >
              {working === 'commit' ? 'Committing…' : 'Commit'}
            </button>
            {canPush && (
              <button type="button" className="btn btn--sm" onClick={() => void push()} disabled={!idle} title={pushTitle}>
                {working === 'push' ? 'Pushing…' : pushLabel}
              </button>
            )}
          </div>
        </>
      )}
      {!hasChanges && canPush && (
        <div className="commit-form__row">
          <span className="commit-form__note">
            {sync?.branch} has {sync?.ahead} commit{sync?.ahead === 1 ? '' : 's'} not on {sync?.upstream ?? 'the remote'}.
          </span>
          <button type="button" className="btn btn--sm" onClick={() => void push()} disabled={!idle} title={pushTitle}>
            {working === 'push' ? 'Pushing…' : pushLabel}
          </button>
        </div>
      )}
      {status && (
        <p className={`commit-form__status${status.error ? ' commit-form__status--error' : ''}`} role="status">
          {status.text}
        </p>
      )}
    </div>
  )
}
