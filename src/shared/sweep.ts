/**
 * The agent's PR-sweep board. The `pr_sweep` tool records the full item list each
 * time it's called — a scratchpad, like `todo_write` — specialized for working a
 * batch of pull requests. The main process validates it and the renderer draws it
 * as a per-PR board. Pure helpers live here so both processes share one
 * definition.
 *
 * State lives entirely in the tool call (+ its result) in the conversation log,
 * which is persisted per chat; there is no separate sweep store.
 *
 * Two modes:
 * - `author`  — turn a list of tasks into PRs: branch → change → push → open PR.
 * - `process` — work a list of existing open PRs: check out → review/fix → update.
 */

export type SweepMode = 'author' | 'process'

export const SWEEP_MODES: SweepMode[] = ['author', 'process']

export type SweepItemStatus =
  | 'pending'
  | 'in_progress'
  | 'pushed'
  | 'pr_open'
  | 'done'
  | 'failed'

export const SWEEP_STATUSES: SweepItemStatus[] = [
  'pending',
  'in_progress',
  'pushed',
  'pr_open',
  'done',
  'failed'
]

export interface SweepItem {
  /** What this item is: a task to author a PR for, or an existing PR to process. */
  task: string
  status: SweepItemStatus
  /** Branch worked on (author mode) or the PR's head branch (process mode). */
  branch?: string
  /** PR reference once known — a number, "#123", or a URL. */
  pr?: string
  /** Short note: a blocker, what was done, or why it failed. */
  note?: string
}

/** Validate the sweep mode, throwing a descriptive error the agent can act on. */
export function parseSweepMode(value: unknown): SweepMode {
  if (typeof value !== 'string' || !SWEEP_MODES.includes(value as SweepMode)) {
    throw new Error(`mode must be one of: ${SWEEP_MODES.join(', ')}.`)
  }
  return value as SweepMode
}

/**
 * Validate and normalize a raw `items` value (as received in tool arguments) into
 * a `SweepItem[]`. Throws a descriptive error on malformed input so the agent gets
 * a useful tool result and can correct itself.
 */
export function parseSweepItems(value: unknown): SweepItem[] {
  if (!Array.isArray(value)) throw new Error('items must be an array.')
  return value.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`items[${i}] must be an object with "task" and "status".`)
    }
    const { task, status, branch, pr, note } = raw as Record<string, unknown>
    if (typeof task !== 'string' || !task.trim()) {
      throw new Error(`items[${i}].task must be a non-empty string.`)
    }
    if (typeof status !== 'string' || !SWEEP_STATUSES.includes(status as SweepItemStatus)) {
      throw new Error(`items[${i}].status must be one of: ${SWEEP_STATUSES.join(', ')}.`)
    }
    const item: SweepItem = { task: task.trim(), status: status as SweepItemStatus }
    if (typeof branch === 'string' && branch.trim()) item.branch = branch.trim()
    if (typeof pr === 'string' && pr.trim()) item.pr = pr.trim()
    else if (typeof pr === 'number' && Number.isFinite(pr)) item.pr = `#${pr}`
    if (typeof note === 'string' && note.trim()) item.note = note.trim()
    return item
  })
}

/** Best-effort parse for display code that must not throw. Returns [] on bad input. */
export function parseSweepItemsSafe(value: unknown): SweepItem[] {
  try {
    return parseSweepItems(value)
  } catch {
    return []
  }
}

/** A short one-line summary for the model-facing tool result and approval text. */
export function formatSweepSummary(mode: SweepMode, items: SweepItem[]): string {
  if (items.length === 0) return `Cleared the ${mode} PR sweep.`
  const count = (s: SweepItemStatus): number => items.filter((i) => i.status === s).length
  const bits = [`${count('done')} done`]
  const open = count('pr_open')
  const active = count('in_progress')
  const failed = count('failed')
  if (open) bits.push(`${open} PR open`)
  if (active) bits.push(`${active} in progress`)
  if (failed) bits.push(`${failed} failed`)
  return `PR sweep (${mode}): ${items.length} item${items.length === 1 ? '' : 's'} — ${bits.join(', ')}.`
}

const MARK: Record<SweepItemStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  pushed: '[↑]',
  pr_open: '[PR]',
  done: '[x]',
  failed: '[!]'
}

/** Render the board as plain text (included in the model-facing tool result). */
export function formatSweepList(items: SweepItem[]): string {
  return items
    .map((it) => {
      const extra = [it.branch, it.pr].filter(Boolean).join(' ')
      const note = it.note ? ` — ${it.note}` : ''
      return `${MARK[it.status]} ${it.task}${extra ? ` (${extra})` : ''}${note}`
    })
    .join('\n')
}
