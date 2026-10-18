import { useState } from 'react'
import type { ProposalState } from '@shared/agent'
import type { ToolItem } from '../lib/items'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

/** What a proposal card needs from the app: the chat's decisions and the actions. */
export interface ProposalHandlers {
  /** Decisions so far, keyed by the proposing call's id (absent = still open). */
  states: Record<string, ProposalState>
  /** Start the proposal as its own background chat. Rejects with a user-facing message. */
  start: (callId: string) => Promise<void>
  /** Ask for it in this chat instead (sends the brief as a message). */
  here: (callId: string, title: string, prompt: string) => Promise<void>
  dismiss: (callId: string) => Promise<void>
  /** Open the session a started proposal became. */
  open: (conversationId: string) => void
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * A session the agent proposed (`propose_session`): what it would do and where,
 * with Start session / Do it here / Dismiss. Nothing runs until the user picks.
 */
export function ProposalCard({
  item,
  handlers
}: {
  item: ToolItem
  handlers?: ProposalHandlers
}): JSX.Element {
  const args = item.args ?? {}
  const title = str(args.title) || 'Proposed session'
  const prompt = str(args.prompt)
  const fork = args.context === 'fork'
  const wt = args.worktree as { branch?: unknown } | undefined
  const branch = wt && typeof wt === 'object' ? str(wt.branch) : ''
  const state = handlers?.states[item.id]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const act = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    fn()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const where = branch ? `On branch ${branch}` : 'On its own worktree in a git project'
  const context = fork ? 'Gets a copy of this chat' : 'Starts fresh with its brief'
  const statusText =
    state?.status === 'started'
      ? 'Started'
      : state?.status === 'here'
        ? 'Asked here'
        : state?.status === 'dismissed'
          ? 'Dismissed'
          : 'Proposed'

  return (
    <div
      className={`proposal-card${state ? ' proposal-card--decided' : ''}`}
      role="group"
      aria-label={`Proposed session: ${title}`}
    >
      <div className="proposal-card__head">
        <span className="proposal-card__icon" aria-hidden="true">
          <Icon name="split" />
        </span>
        <span className="proposal-card__title">{title}</span>
        <span className={`proposal-card__pill proposal-card__pill--${state?.status ?? 'open'}`}>
          {statusText}
        </span>
      </div>
      <p className="proposal-card__meta">
        {where} · {context}
      </p>
      {prompt && (
        <details className="proposal-card__brief">
          <summary>Brief</summary>
          <Markdown text={prompt} />
        </details>
      )}
      {error && (
        <p className="proposal-card__error" role="alert">
          {error}
        </p>
      )}
      {handlers && !state && (
        <div className="proposal-card__actions">
          <button
            type="button"
            className="btn btn--sm btn--accent"
            disabled={busy}
            onClick={() => act(() => handlers.start(item.id))}
          >
            {busy ? 'Starting…' : 'Start session'}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => act(() => handlers.here(item.id, title, prompt))}
          >
            Do it here
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => act(() => handlers.dismiss(item.id))}
          >
            Dismiss
          </button>
        </div>
      )}
      {handlers && state?.status === 'started' && state.conversationId && (
        <div className="proposal-card__actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => handlers.open(state.conversationId as string)}
          >
            Open session
          </button>
        </div>
      )}
    </div>
  )
}
