import { Icon } from './Icon'
import { Tooltip } from './Tooltip'
import type { BackgroundTask } from '../hooks/useBackgroundTasks'

/**
 * How many tasks need attention: backgrounded shells that are running, plus exited
 * ones that left a server running. An integrated terminal is user-opened and stays
 * "running" the whole time it's open, so counting it would keep the badge
 * permanently lit; terminals still appear in the panel, they just don't nag here.
 */
export function activeTaskCount(tasks: readonly BackgroundTask[]): number {
  return tasks.filter((t) => t.kind !== 'terminal' && (t.status === 'running' || t.status === 'leftover'))
    .length
}

/**
 * Title-bar button for background tasks: integrated terminals and the agent's
 * backgrounded shells. It shows a pulsing count while backgrounded work is live and
 * toggles the Tasks tab of the right-hand dock. It never opens anything on its own:
 * the count is the signal, and the user decides when to look.
 */
export function BackgroundTasks({
  tasks,
  active,
  onToggle
}: {
  tasks: BackgroundTask[]
  /** The dock is open on the Tasks tab. */
  active: boolean
  onToggle: () => void
}): JSX.Element {
  const count = activeTaskCount(tasks)
  return (
    <Tooltip label={count > 0 ? `Background tasks: ${count} running` : 'Background tasks'}>
      <button
        type="button"
        className={`titlebar__action bgtasks__btn${active ? ' titlebar__action--active' : ''}`}
        aria-label={count > 0 ? `Background tasks, ${count} running` : 'Background tasks'}
        aria-pressed={active}
        onClick={onToggle}
      >
        <Icon name="tasks" size={15} />
        {count > 0 && (
          <span className="titlebar__badge bgtasks__count" data-running="">
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  )
}
