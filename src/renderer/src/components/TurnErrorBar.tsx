import { useState } from 'react'
import type { ConversationError } from '@shared/agent'
import { TURN_ERROR_ACTION_LABEL, turnErrorHelp, type TurnErrorAction } from '@shared/turnError'
import { Icon } from './Icon'

/**
 * The bar above the composer after a turn fails: what went wrong in plain words, what
 * to do about it, the buttons for those next steps, and the provider's own message
 * one click away (it is also in the transcript, as the error notice).
 */
export function TurnErrorBar({
  failure,
  onAction
}: {
  /** What the run reported; null when only the fact of the failure is known. */
  failure: ConversationError | null
  onAction: (action: TurnErrorAction) => void
}): JSX.Element {
  const [showRaw, setShowRaw] = useState(false)
  const message = failure?.message ?? ''
  const help = turnErrorHelp(failure?.cause, message)
  // Retry always stays on offer, last when the cause suggests something better first.
  const actions = help.actions.includes('retry') ? help.actions : [...help.actions, 'retry' as const]
  return (
    <div className="turn-error" role="status">
      <div className="turn-error__text">
        <span className="turn-error__summary">{help.summary}</span> <span className="turn-error__hint">{help.hint}</span>
      </div>
      <div className="turn-error__actions">
        {actions.map((a, i) => (
          <button
            key={a}
            className={`btn btn--sm${i === 0 ? ' btn--accent' : ''}`}
            onClick={() => onAction(a)}
          >
            {a === 'retry' && <Icon name="refresh" />} {TURN_ERROR_ACTION_LABEL[a]}
          </button>
        ))}
        {message && (
          <button
            className="btn btn--sm"
            aria-expanded={showRaw}
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? 'Hide details' : 'Details'}
          </button>
        )}
      </div>
      {showRaw && message && <pre className="turn-error__raw">{message}</pre>}
    </div>
  )
}
