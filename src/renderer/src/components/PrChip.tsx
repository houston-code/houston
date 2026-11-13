import type { PrStatus } from '@shared/gitActions'

const STATE_LABEL: Record<PrStatus['state'], string> = { OPEN: 'Open', CLOSED: 'Closed', MERGED: 'Merged' }
const CHECKS_LABEL: Record<PrStatus['checks'], string> = {
  passing: 'Checks passed',
  failing: 'Checks failing',
  pending: 'Checks running',
  none: 'No checks'
}
const CHECKS_MARK: Record<PrStatus['checks'], string> = { passing: '✓', failing: '✕', pending: '◐', none: '' }

/** One line for the tooltip and screen readers: the PR, its state, and its checks in numbers. */
export function prChipDescription(pr: PrStatus): string {
  const state = pr.isDraft && pr.state === 'OPEN' ? 'Draft' : STATE_LABEL[pr.state]
  const { passing, failing, pending } = pr.counts
  const parts = [failing && `${failing} failing`, pending && `${pending} running`, passing && `${passing} passed`].filter(Boolean)
  const checks = parts.length ? `checks: ${parts.join(', ')}` : 'no checks'
  return `Pull request #${pr.number} (${state}): ${pr.title}. ${checks[0].toUpperCase()}${checks.slice(1)}. Opens on GitHub.`
}

/**
 * The chat's branch's pull request beside the composer: number, state and CI checks,
 * opening the PR on GitHub. The link goes through the app's external-link handler,
 * which only opens web addresses in the browser.
 */
export function PrChip({ pr }: { pr: PrStatus }): JSX.Element {
  const state = pr.isDraft && pr.state === 'OPEN' ? 'Draft' : STATE_LABEL[pr.state]
  const description = prChipDescription(pr)
  return (
    <a
      className={`pr-chip pr-chip--${pr.state.toLowerCase()}`}
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={description}
      aria-label={description}
    >
      <span className="pr-chip__num">#{pr.number}</span>
      <span className="pr-chip__state">{state}</span>
      {pr.state === 'OPEN' && pr.checks !== 'none' && (
        <span className={`pr-chip__checks pr-chip__checks--${pr.checks}`}>
          <span aria-hidden="true">{CHECKS_MARK[pr.checks]}</span> {CHECKS_LABEL[pr.checks]}
        </span>
      )}
    </a>
  )
}
