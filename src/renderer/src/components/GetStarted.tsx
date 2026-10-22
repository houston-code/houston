import { useEffect, useRef } from 'react'
import { checklistView, type ChecklistFacts, type ChecklistStep } from '@shared/onboarding'

/**
 * The welcome screen's get-started checklist. Each step ticks itself off from real
 * app state (a usable model, an open folder, a sent task), so it can't drift out of
 * sync with what the user actually did. See @shared/onboarding for when it shows.
 */

const STEPS: { id: ChecklistStep; title: string; hint: string }[] = [
  { id: 'model', title: 'Connect a model', hint: 'Add an API key or use a local model.' },
  { id: 'folder', title: 'Open a project folder', hint: 'Houston works inside the folder you choose.' },
  { id: 'task', title: 'Send your first task', hint: 'Type it in the message box below and press ↵.' }
]

export interface GetStartedProps {
  facts: ChecklistFacts
  /** What step 1 connected, e.g. "Anthropic · Claude Sonnet 5.5", shown once it's done. */
  modelSummary?: string
  /** The folder step 2 opened, e.g. "my-app", shown once it's done. */
  folderSummary?: string
  /** An example first task suited to the folder, appended to step 3's hint. */
  taskExample?: string
  onConnectModel: () => void
  onChooseFolder: () => void
  /**
   * Focus step 1's button on mount. Set when the user backs out of the Connect panel,
   * which replaced this card while open: without it focus falls to the page body.
   */
  focusModelStep?: boolean
}

export function GetStarted({
  facts,
  modelSummary,
  folderSummary,
  taskExample,
  onConnectModel,
  onChooseFolder,
  focusModelStep = false
}: GetStartedProps): JSX.Element {
  const view = checklistView(facts)
  const modelButton = useRef<HTMLButtonElement>(null)
  // Mount-only: a later re-render (a fact ticking over) must not pull focus back here.
  useEffect(() => {
    if (focusModelStep) modelButton.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const action: Partial<Record<ChecklistStep, { label: string; run: () => void }>> = {
    model: { label: 'Connect', run: onConnectModel },
    folder: { label: 'Choose folder', run: onChooseFolder }
  }
  // While setup is open, a finished step can be revisited: it shows what it set and a
  // Change button that reopens the same action (Connect panel, folder picker).
  const change: Partial<Record<ChecklistStep, { summary?: string; label: string; run: () => void }>> = {
    model: { summary: modelSummary, label: 'Change model', run: onConnectModel },
    folder: { summary: folderSummary, label: 'Change folder', run: onChooseFolder }
  }

  return (
    <section className="onboard-card get-started" aria-labelledby="get-started-title">
      <div className="get-started__head">
        <h2 id="get-started-title" className="onboard-card__title">
          Get started
        </h2>
        <span className="get-started__count">
          {view.completed} of {STEPS.length}
        </span>
      </div>
      <ol className="get-started__steps">
        {STEPS.map((step, i) => {
          const done = view.done[step.id]
          const current = view.current === step.id
          const act = action[step.id]
          const redo = done ? change[step.id] : undefined
          return (
            <li
              key={step.id}
              className={`get-started__step${done ? ' is-done' : ''}${current ? ' is-current' : ''}`}
              aria-current={current ? 'step' : undefined}
            >
              <span className="get-started__dot" aria-hidden="true">
                {done ? '✓' : i + 1}
              </span>
              <span className="get-started__text">
                <span className="get-started__title">
                  {step.title}
                  {done && <span className="sr-only"> (done)</span>}
                </span>
                {!done && (
                  <span className="get-started__hint">
                    {step.hint}
                    {step.id === 'task' && taskExample && <> For example: &ldquo;{taskExample}&rdquo;</>}
                  </span>
                )}
                {redo?.summary && <span className="get-started__hint">{redo.summary}</span>}
              </span>
              {act && !done && (
                <button
                  ref={step.id === 'model' ? modelButton : undefined}
                  type="button"
                  className={`btn btn--sm${current ? ' btn--accent' : ''}`}
                  onClick={act.run}
                >
                  {act.label}
                </button>
              )}
              {redo && (
                <button
                  ref={step.id === 'model' ? modelButton : undefined}
                  type="button"
                  className="btn btn--sm"
                  aria-label={redo.label}
                  onClick={redo.run}
                >
                  Change
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}
