import type { StarterPrompt } from '@shared/onboarding'

/**
 * Clickable starter tasks on an empty chat. A chip fills the message box rather than
 * sending, so the task can be read and changed first.
 */
export function StarterPrompts({
  prompts,
  onPick
}: {
  prompts: readonly StarterPrompt[]
  onPick: (prompt: string) => void
}): JSX.Element | null {
  if (prompts.length === 0) return null
  return (
    <section className="starters" aria-label="Starter tasks">
      <p className="starters__title">Try one of these, or type your own below.</p>
      <ul className="starters__list">
        {prompts.map((p) => (
          <li key={p.label}>
            <button type="button" className="starters__chip" title={p.task} onClick={() => onPick(p.task)}>
              {p.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
