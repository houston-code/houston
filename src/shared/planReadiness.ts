/**
 * Can a plan's checks actually run here? Asked when the plan is presented, before
 * any code is written.
 *
 * An agent can build a whole app around tests it will never be able to run (the
 * dependencies need network the shell doesn't have, the runtime isn't installed) and
 * only find out at the end, if at all. Houston knows most of that up front from the
 * plan itself and the machine: which ecosystems the plan touches, whether their
 * runtimes are on PATH, whether their dependencies are installed, and whether shell
 * commands can reach the network this run. The review panel shows the answer next to
 * the plan, and the agent is told the problems when the plan is accepted.
 *
 * This module holds the shape, the verification-step reading, and the wording the
 * clients share. It is pure; the main process gathers the facts (agent/readiness.ts)
 * without running anything.
 */

/** One thing the plan's checks depend on, and whether this machine has it. */
export interface ReadinessItem {
  /** What it is, in a few words: "Python 3", "npm packages (frontend/package.json)". */
  need: string
  status: 'ok' | 'missing' | 'needs-network' | 'unavailable'
  /** One sentence the user (and the agent) can act on. */
  detail: string
}

/** The answer for one plan, computed when it is presented. */
export interface PlanReadiness {
  items: ReadinessItem[]
}

/** Whether every item is ok (nothing for the user to act on). */
export function readinessOk(r: PlanReadiness): boolean {
  return r.items.every((i) => i.status === 'ok')
}

/** The items that need the user's attention, in order. */
export function readinessProblems(r: PlanReadiness): ReadinessItem[] {
  return r.items.filter((i) => i.status !== 'ok')
}

/** A one-character mark for an item, for the terminal clients. */
export function readinessGlyph(i: ReadinessItem): string {
  return i.status === 'ok' ? '✓' : '!'
}

/** The readiness as plain lines for the terminal clients. */
export function formatReadinessLines(r: PlanReadiness): string[] {
  if (!r.items.length) return []
  const head = readinessOk(r)
    ? 'Can these checks run here: yes'
    : 'Can these checks run here: not as things stand'
  return [head, ...r.items.map((i) => `  ${readinessGlyph(i)} ${i.need}: ${i.detail}`)]
}

/** A markdown heading that introduces the plan's verification section. */
const VERIFY_HEADING = /^#{1,6}\s.*\b(verif\w*|test\w*|check\w*|validat\w*)\b/i

/**
 * The checks a plan says it will run: its `verify` list when the agent gave one,
 * else the bullets under the first verification heading in its markdown (a plan
 * written before the field existed, or one the user edited by hand). Each step is one
 * line; empty when the plan names none.
 */
export function planVerifySteps(plan: { verify?: string[]; body?: string }): string[] {
  const listed = (plan.verify ?? []).map((s) => s.trim()).filter(Boolean)
  if (listed.length) return listed
  const lines = (plan.body ?? '').split('\n')
  const start = lines.findIndex((l) => VERIFY_HEADING.test(l.trim()))
  if (start === -1) return []
  const steps: string[] = []
  for (const line of lines.slice(start + 1)) {
    const t = line.trim()
    if (/^#{1,6}\s/.test(t)) break
    const bullet = t.match(/^(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (bullet && bullet[1].trim()) steps.push(bullet[1].trim())
  }
  return steps
}
