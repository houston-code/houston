import type { ProjectFacts } from '@shared/onboarding'

/**
 * What Houston knows about the open folder, on an empty new chat: its name, branch
 * and recognized stack, and whether it has an instructions file. With none, it offers
 * to write one (`/init`), since that file is what tells the agent how to build and
 * test the project on every run.
 */
export function ProjectCard({
  name,
  branch,
  facts,
  onGenerate
}: {
  name: string
  /** The repository's current branch, when the folder is a git repository. */
  branch?: string | null
  facts: ProjectFacts
  /** Run `/init`. Absent hides the button (for example while a turn can't start). */
  onGenerate?: () => void
}): JSX.Element {
  const details = [branch ? `on ${branch}` : null, facts.stack.length ? facts.stack.join(', ') : null].filter(Boolean)
  return (
    <section className="project-card" aria-label="Project">
      <p className="project-card__head">
        <strong>{name}</strong>
        {details.length > 0 && <span className="project-card__details"> · {details.join(' · ')}</span>}
      </p>
      {facts.instructions ? (
        <p className="project-card__line">
          <span className="project-card__ok" aria-hidden="true">
            ✓
          </span>{' '}
          Houston reads <code>{facts.instructions}</code> at the start of every run.
        </p>
      ) : (
        <p className="project-card__line">
          No <code>AGENTS.md</code> yet. It tells the agent how to build, test and work in this
          project.
          {onGenerate && (
            <>
              {' '}
              <button type="button" className="project-card__action" onClick={onGenerate}>
                Write one with /init
              </button>
            </>
          )}
        </p>
      )}
    </section>
  )
}
