import { useEffect, useRef, useState } from 'react'
import {
  rewindConfirmText,
  type RewindMode,
  type RewindPreview
} from '@shared/rewind'
import { useFocusTrap } from '../lib/useFocusTrap'

/** The message a rewind targets, as the transcript numbers and shows it. */
export interface RewindTarget {
  /** Position among the user's messages (0 = the first). */
  turn: number
  /** What the user wrote (the typed command for an invoked turn); checked by main. */
  text: string
  /** One-line label for the dialog. */
  label: string
}

const MODE_LABEL: Record<RewindMode, string> = {
  both: 'Conversation and code',
  conversation: 'Conversation only',
  code: 'Code only'
}

const MODE_HINT: Record<RewindMode, string> = {
  both: 'Remove this message and everything after it, and put back the files the agent changed.',
  conversation: 'Remove this message and everything after it. Files stay as they are.',
  code: 'Put back the files the agent changed from this message on. The chat stays.'
}

const ORDER: RewindMode[] = ['both', 'conversation', 'code']

/**
 * Confirm a rewind: pick what to rewind, see what it will change (how many messages
 * and files, which files changed outside the agent and will be left alone), then
 * confirm. The preview is main's dry run of the same walk the rewind does, so the
 * counts match. "Edit and resend" hands the message to the composer instead.
 */
export function RewindDialog({
  conversationId,
  target,
  initialMode = 'both',
  onCancel,
  onConfirm,
  onEdit
}: {
  conversationId: string
  target: RewindTarget
  initialMode?: RewindMode
  onCancel: () => void
  onConfirm: (mode: RewindMode) => void
  /** Put the message in the composer to edit and resend (absent: no such button). */
  onEdit?: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, onCancel)
  const [mode, setMode] = useState<RewindMode>(initialMode)
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setPreview(null)
    setError(null)
    window.api
      .previewRewind(conversationId, target.turn, mode, target.text)
      .then((r) => {
        if (!live) return
        if (r.ok) setPreview(r)
        else setError(r.error)
      })
      .catch(() => live && setError("Couldn't check what this rewind would change."))
    return () => {
      live = false
    }
  }, [conversationId, target.turn, target.text, mode])

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal modal--sm rewind-dialog"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rewind-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="rewind-dialog-title">Rewind to this message?</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal__body">
          <p className="rewind-dialog__target">“{target.label}”</p>
          <fieldset className="rewind-dialog__modes">
            <legend className="rewind-dialog__legend">What to rewind</legend>
            {ORDER.map((m) => (
              <label key={m} className="rewind-dialog__mode">
                <input
                  type="radio"
                  name="rewind-mode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                <span>
                  <span className="rewind-dialog__mode-label">{MODE_LABEL[m]}</span>
                  <span className="rewind-dialog__mode-hint">{MODE_HINT[m]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="rewind-dialog__summary" role="status" aria-live="polite">
            {error ?? (preview ? rewindConfirmText(mode, preview) : 'Checking what will change…')}
          </p>
        </div>
        <div className="modal__foot">
          {onEdit && (
            <button className="btn btn--sm rewind-dialog__edit" onClick={onEdit}>
              Edit and resend
            </button>
          )}
          <button className="btn btn--sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn--sm btn--danger"
            disabled={!preview || error !== null}
            onClick={() => onConfirm(mode)}
          >
            Rewind
          </button>
        </div>
      </div>
    </div>
  )
}
