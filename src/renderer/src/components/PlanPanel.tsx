import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { PlanAcceptMode, PlanDecision, PlanPayload } from '@shared/agent'
import { Markdown } from './Markdown'
import { Icon } from './Icon'

/**
 * The docked plan-review panel. Appears on the right when the agent presents a plan
 * in Plan mode (via `present_plan`) and blocks for the user's decision. Mirrors the
 * Plan-mode workflow: accept and carry it out (choosing how edits run), request
 * changes (the agent revises and re-presents), or reject and keep planning.
 *
 * While `revising` (the user asked for changes) the panel stays up in a working
 * state until the agent sends the revised plan.
 */
export function PlanPanel({
  plan,
  revising,
  onResolve,
  onClose,
  onResizeMouseDown
}: {
  plan: PlanPayload
  /** True after "suggest changes" — awaiting the agent's revised plan. */
  revising: boolean
  onResolve: (decision: PlanDecision) => void
  onClose: () => void
  onResizeMouseDown: (e: React.MouseEvent) => void
}): JSX.Element {
  const [editMode, setEditMode] = useState<PlanAcceptMode>('auto-edit')
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [note, setNote] = useState('')
  const rootRef = useRef<HTMLElement>(null)
  const suggestRef = useRef<HTMLTextAreaElement>(null)

  // Focus the panel when it opens so the A / S / R shortcuts work without a click.
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const accept = (): void => onResolve({ kind: 'accept', mode: editMode })
  const reject = (): void => onResolve({ kind: 'reject' })
  const openSuggest = (): void => {
    setSuggestOpen(true)
    // Focus the textarea after it renders.
    setTimeout(() => suggestRef.current?.focus(), 0)
  }
  const sendSuggestion = (): void => {
    const trimmed = note.trim()
    if (!trimmed) {
      suggestRef.current?.focus()
      return
    }
    onResolve({ kind: 'suggest', note: trimmed })
    setNote('')
    setSuggestOpen(false)
  }

  // A / S / R shortcuts, scoped to the focused panel. Ignored while a field is
  // focused (so typing a suggestion isn't hijacked), with a modifier held (leaves
  // Cmd+A etc. alone), or while the plan is being revised.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>): void => {
    if (revising) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const el = e.target as HTMLElement
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return
    const k = e.key.toLowerCase()
    if (k === 'a') {
      e.preventDefault()
      accept()
    } else if (k === 's') {
      e.preventDefault()
      openSuggest()
    } else if (k === 'r') {
      e.preventDefault()
      reject()
    }
  }

  const stepCount = plan.steps?.length ?? 0
  const fileCount = plan.files?.length ?? 0
  const meta = [
    // The step count only applies to legacy structured plans; a freeform `body`
    // plan just notes the files it touches.
    stepCount > 0 ? `${stepCount} step${stepCount === 1 ? '' : 's'}` : null,
    fileCount > 0 ? `touches ${fileCount} file${fileCount === 1 ? '' : 's'}` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <aside
      className="plan-panel"
      aria-label="Plan review"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={onKeyDown}
    >
      <div
        className="plan-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize plan panel"
        onMouseDown={onResizeMouseDown}
      />

      <header className="plan-panel__head">
        <span className="plan-panel__badge" aria-hidden="true">
          <Icon name="clipboard" />
        </span>
        <span className="plan-panel__heading">Plan review</span>
        <span className="plan-panel__pill">Read-only</span>
        <button
          type="button"
          className="plan-panel__close"
          title="Dismiss (reopen from the transcript)"
          aria-label="Dismiss plan panel"
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>

      <div className="plan-panel__title">
        <h2>{plan.title}</h2>
        {meta && <p className="plan-panel__meta">{meta}</p>}
      </div>

      {/* One scroll region for the whole plan: the model's freeform markdown (or, for
          older plans, the structured overview + steps), then the files as a collapsed
          disclosure at the end. Keeping files in here (rather than as a sibling above)
          stops a long list from starving the plan. */}
      <div className="plan-panel__body">
        {plan.body ? (
          <div className="plan-panel__markdown">
            <Markdown text={plan.body} />
          </div>
        ) : (
          <>
            {plan.overview && (
              <div className="plan-panel__overview">
                <Markdown text={plan.overview} />
              </div>
            )}
            {plan.steps && plan.steps.length > 0 && (
              <>
                <p className="plan-panel__section-label">Steps</p>
                <ol className="plan-panel__steps">
                  {plan.steps.map((step, i) => (
                    <li key={i}>
                      <Markdown text={step} />
                    </li>
                  ))}
                </ol>
              </>
            )}
          </>
        )}
        {plan.files && plan.files.length > 0 && (
          <details className="plan-panel__files">
            <summary>
              <svg
                className="plan-panel__files-caret"
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 4l4 4-4 4" />
              </svg>
              Files this plan will change ·{' '}
              <span className="plan-panel__files-count">{plan.files.length}</span>
            </summary>
            <div className="plan-panel__chips">
              {plan.files.map((f) => (
                <span key={f} className="plan-panel__chip" title={f}>
                  {f}
                </span>
              ))}
            </div>
          </details>
        )}
      </div>

      <footer className="plan-panel__foot">
        {revising ? (
          <div className="plan-panel__revising" role="status">
            <span className="plan-panel__spinner" aria-hidden="true" />
            Revising the plan with your changes…
          </div>
        ) : (
          <>
            {suggestOpen && (
              <div className="plan-panel__suggest">
                <textarea
                  ref={suggestRef}
                  className="plan-panel__note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      sendSuggestion()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setSuggestOpen(false)
                    }
                  }}
                  placeholder="What should change? e.g. “Debounce at 250ms and also persist on window blur.”"
                  aria-label="Suggested changes to the plan"
                />
                <div className="plan-panel__suggest-actions">
                  <button className="btn btn--sm plan-panel__ghost" onClick={() => setSuggestOpen(false)}>
                    Cancel
                  </button>
                  <button className="btn btn--sm btn--accent" onClick={sendSuggestion} disabled={!note.trim()}>
                    Send to agent
                  </button>
                </div>
              </div>
            )}

            <div className="plan-panel__mode">
              <span className="plan-panel__mode-label">After accepting, run edits:</span>
              <div className="plan-panel__seg" role="group" aria-label="How edits run after accepting">
                <button
                  type="button"
                  aria-pressed={editMode === 'auto-edit'}
                  onClick={() => setEditMode('auto-edit')}
                >
                  Auto-approve
                </button>
                <button
                  type="button"
                  aria-pressed={editMode === 'ask'}
                  onClick={() => setEditMode('ask')}
                >
                  Ask each
                </button>
              </div>
            </div>

            <div className="plan-panel__actions">
              <button className="btn btn--accent plan-panel__accept" onClick={accept}>
                Accept &amp; run <kbd>A</kbd>
              </button>
              <button className="btn plan-panel__suggest-btn" onClick={openSuggest}>
                Suggest changes <kbd>S</kbd>
              </button>
              <button className="btn btn--danger plan-panel__reject" onClick={reject}>
                Reject plan <kbd>R</kbd>
              </button>
            </div>
          </>
        )}
      </footer>
    </aside>
  )
}
