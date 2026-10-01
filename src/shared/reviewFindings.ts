import type { ReviewFinding, ReviewSeverity } from './agent'

/**
 * Display helpers for live review findings (the `review_finding` agent event),
 * shared by the GUI row and the terminal clients so they order, count, and word
 * findings the same way.
 */

export const SEVERITY_ORDER: readonly ReviewSeverity[] = ['critical', 'high', 'medium', 'low']

/** Upsert a finding by id, keeping first-seen order. Pure. */
export function upsertFinding(list: readonly ReviewFinding[], f: ReviewFinding): ReviewFinding[] {
  const idx = list.findIndex((x) => x.id === f.id)
  return idx >= 0 ? list.map((x, i) => (i === idx ? f : x)) : [...list, f]
}

/** Most severe first; ties keep arrival order. Pure. */
export function sortFindings(list: readonly ReviewFinding[]): ReviewFinding[] {
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.f.severity) - SEVERITY_ORDER.indexOf(b.f.severity) || a.i - b.i)
    .map(({ f }) => f)
}

/** Findings the verifier dropped (rejected as false positives, or merged into another). */
export function isDropped(f: ReviewFinding): boolean {
  return f.status === 'rejected' || f.status === 'merged'
}

/**
 * The review row's summary once it's finished: confirmed (or still unverified)
 * findings counted by severity, e.g. "2 high · 1 low", or "no confirmed issues"
 * when every finding was dropped. Null when there are no findings at all. Pure.
 */
export function findingTally(list: readonly ReviewFinding[]): string | null {
  if (list.length === 0) return null
  const kept = list.filter((f) => !isDropped(f))
  if (kept.length === 0) return 'no confirmed issues'
  return SEVERITY_ORDER.map((s) => [s, kept.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`)
    .join(' · ')
}

/** "N dropped as false positives", naming merged duplicates separately. Null when none. */
export function droppedSummary(list: readonly ReviewFinding[]): string | null {
  const rejected = list.filter((f) => f.status === 'rejected').length
  const merged = list.filter((f) => f.status === 'merged').length
  const parts: string[] = []
  if (rejected) parts.push(`${rejected} dropped as ${rejected === 1 ? 'a false positive' : 'false positives'}`)
  if (merged) parts.push(`${merged} merged as ${merged === 1 ? 'a duplicate' : 'duplicates'}`)
  return parts.length ? parts.join(', ') : null
}

const CLI_MARK: Record<ReviewFinding['status'], string | null> = {
  candidate: '◇',
  verifying: null, // a transient state: the next line for this finding is its verdict
  confirmed: '✓',
  rejected: '✕',
  merged: '↳'
}

/**
 * Drop C0/DEL/C1 control characters. A finding's text is model output quoting repo
 * content, so it can carry terminal escapes (cursor moves, OSC hyperlinks) that would
 * rewrite what the user sees; the terminal clients print it raw otherwise.
 */
function plain(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

/** One terminal line for a finding (no indent or color), or null for a state not printed. */
export function findingLine(f: ReviewFinding): string | null {
  const mark = CLI_MARK[f.status]
  if (!mark) return null
  const what = plain([f.location, f.title].filter(Boolean).join('  '))
  if (f.status === 'rejected') return `${mark} rejected  ${what}`
  if (f.status === 'merged') return `${mark} merged  ${what}`
  return `${mark} ${f.severity.toUpperCase().padEnd(8)}  ${what}`
}

/**
 * A line-mode printer for findings: returns the line to print for an event, or null
 * when the finding's status hasn't changed since it was last printed. High-effort
 * votes re-emit a settled finding as its remaining skeptics answer, and a terminal
 * can't update a line in place, so without this the same verdict would repeat.
 */
export function createFindingPrinter(): (parentCallId: string, f: ReviewFinding) => string | null {
  const last = new Map<string, ReviewFinding['status']>()
  return (parentCallId, f) => {
    const key = `${parentCallId}\u0000${f.id}`
    if (last.get(key) === f.status) return null
    last.set(key, f.status)
    return findingLine(f)
  }
}
