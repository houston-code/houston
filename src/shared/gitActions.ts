/**
 * Commit, push and pull-request status the desktop app runs itself, without an agent
 * turn: the Changes view's commit form and the composer's PR chip. Shared types and
 * the pure pieces; the git and gh calls live in src/main/agent/gitActions.ts.
 */

export type GitActionResult = { ok: true; detail?: string } | { ok: false; error: string }

/** The branch's position against its upstream, for the Push button. */
export interface BranchSync {
  branch: string | null
  /** `origin/feature`, or null when the branch has no upstream yet. */
  upstream: string | null
  /** Commits on the branch not on its upstream (all of them when there is no upstream). */
  ahead: number
  /** The remote a first push would go to, or null when the repository has none. */
  remote: string | null
}

export type CheckState = 'passing' | 'failing' | 'pending' | 'none'

/** The open chat's branch's pull request, as the composer chip shows it. */
export interface PrStatus {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  isDraft: boolean
  url: string
  checks: CheckState
  /** Checks counted by outcome, for the chip's tooltip. */
  counts: { passing: number; failing: number; pending: number }
}

/** What the PR lookup found: a PR, none for this branch, or no way to ask. */
export type PrLookup =
  | { kind: 'pr'; pr: PrStatus }
  | { kind: 'none' }
  /** gh is missing or signed in nowhere, or the folder has no GitHub remote: show nothing. */
  | { kind: 'unavailable' }

/** Longest commit message accepted (a message, not a file). */
export const MAX_COMMIT_MESSAGE = 20_000

/**
 * Clean a commit message from the form: control characters other than newline and
 * tab are dropped, line endings normalized, and surrounding blank lines trimmed.
 * Null when nothing is left or it is too long.
 */
export function cleanCommitMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  if (!text || text.length > MAX_COMMIT_MESSAGE) return null
  return text
}

const FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

/**
 * Sum up gh's `statusCheckRollup` (check runs carry status + conclusion, commit
 * statuses carry a state). Any failure fails the whole; otherwise anything still
 * running makes it pending; otherwise passing, or none when there are no checks. Pure.
 */
export function summarizeChecks(rollup: unknown): { checks: CheckState; counts: PrStatus['counts'] } {
  const counts = { passing: 0, failing: 0, pending: 0 }
  if (Array.isArray(rollup)) {
    for (const c of rollup) {
      if (!c || typeof c !== 'object') continue
      const o = c as Record<string, unknown>
      const status = typeof o.status === 'string' ? o.status.toUpperCase() : ''
      const conclusion = typeof o.conclusion === 'string' ? o.conclusion.toUpperCase() : ''
      const state = typeof o.state === 'string' ? o.state.toUpperCase() : ''
      const outcome = conclusion || state
      if (status && status !== 'COMPLETED') counts.pending++
      else if (FAILING.has(outcome)) counts.failing++
      else if (PASSING.has(outcome)) counts.passing++
      else counts.pending++
    }
  }
  const checks: CheckState =
    counts.failing > 0 ? 'failing' : counts.pending > 0 ? 'pending' : counts.passing > 0 ? 'passing' : 'none'
  return { checks, counts }
}

/** Parse `gh pr view --json number,title,state,isDraft,url,statusCheckRollup`. Null when it doesn't fit. */
export function parsePrView(stdout: string): PrStatus | null {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const number = o.number
  const state = typeof o.state === 'string' ? o.state.toUpperCase() : ''
  const url = typeof o.url === 'string' ? o.url : ''
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return null
  if (!/^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+$/.test(url)) return null
  const title = typeof o.title === 'string' ? o.title.slice(0, 300) : ''
  return { number, title, state, isDraft: o.isDraft === true, url, ...summarizeChecks(o.statusCheckRollup) }
}
