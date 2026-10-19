import { checklistView, type ChecklistFacts, type ChecklistStep } from '@shared/onboarding'

/**
 * The welcome screen's get-started checklist. Each step ticks itself off from real
 * app state (a usable model, an open folder, a sent task), so it can't drift out of
 * sync with what the user actually did. See @shared/onboarding for when it shows.
 */

const STEPS: { id: ChecklistStep; title: string; hint: string }[] = [
  { id: 'model', title: 'Connect a model', hint: 'Add an API key or use a local model.' },
  { id: 'folder', title: 'Open a project folder', hint: 'Houston works inside the folder you choose.' },
  { id: 'task', title: 'Send your first task', hint: 'Try "Explain how this project is organized."' }
]

export interface GetStartedProps {
  facts: ChecklistFacts
  /** What step 1 connected, e.g. "Anthropic · Claude Sonnet 5.5", shown once it's done. */
  modelSummary?: string
  onConnectModel: () => void
  onChooseFolder: () => void
  onSkip: () => void
}

export function GetStarted({
  facts,
  modelSummary,
  onConnectModel,
  onChooseFolder,
  onSkip
}: GetStartedProps): JSX.Element {
  const view = checklistView(facts)
  const action: Partial<Record<ChecklistStep, { label: string; run: () => void }>> = {
    model: { label: 'Connect', run: onConnectModel },
    folder: { label: 'Choose folder', run: onChooseFolder }
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
                {!done && <span className="get-started__hint">{step.hint}</span>}
                {done && step.id === 'model' && modelSummary && (
                  <span className="get-started__hint">{modelSummary}</span>
                )}
              </span>
              {act && !done && (
                <button
                  type="button"
                  className={`btn btn--sm${current ? ' btn--accent' : ''}`}
                  onClick={act.run}
                >
                  {act.label}
                </button>
              )}
              {done && step.id === 'model' && (
                // Back to step 1 while setup is still open: switch model or provider.
                <button
                  type="button"
                  className="btn btn--sm"
                  aria-label="Change model"
                  onClick={onConnectModel}
                >
                  Change
                </button>
              )}
            </li>
          )
        })}
      </ol>
      <div className="get-started__foot">
        <button type="button" className="get-started__skip" onClick={onSkip}>
          Skip setup
        </button>
      </div>
    </section>
  )
}
