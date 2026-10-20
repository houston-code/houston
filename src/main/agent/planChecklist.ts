import { statSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_NOTE_PREFIX, type ChatMessage } from '@shared/agent'
import { PRESENT_PLAN_TOOL } from '@shared/constants'
import type { CheckKind, PlanCheckStatus, PlanProgress, ReceiptCheck, TurnReceipt } from '@shared/evidence'
import { planVerifySteps } from '@shared/planReadiness'
import { classifyCommand } from './evidence'
import { checksNamedBy, type RequiredCheck } from './todoEvidence'

/**
 * An accepted plan, held against what every turn since recorded.
 *
 * "Finish the planned implementation" is often a later turn than the one that
 * accepted the plan, so this works from the conversation log, never from run state:
 * the plan (its files and checks) is the present_plan call the log already holds, and
 * the evidence is the receipts saved on the turns since. Nothing new is stored, and a
 * reopened chat gives the same answer.
 */

/** The plan the user last accepted, as the log holds it. */
export interface AcceptedPlan {
  /** Index of the assistant message that called present_plan. */
  index: number
  title: string
  files: string[]
  /** The checks it said it would run (its verify list, or its verification section). */
  checks: string[]
}

const ACCEPTED = 'The user ACCEPTED the plan'
const EDITED_START = 'even where it differs from yours:\n\n'
const EDITED_END = /\n\n(Edits will be applied automatically|You will be asked to approve)/

/** The body the user accepted: their hand edit when they made one, else the plan as presented. */
function acceptedBody(result: string, presented: string): string {
  const start = result.indexOf(EDITED_START)
  if (start === -1) return presented
  const rest = result.slice(start + EDITED_START.length)
  const end = rest.search(EDITED_END)
  return end === -1 ? rest : rest.slice(0, end)
}

const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : []

/**
 * The plan in force: the latest present_plan in the log, when the user accepted it.
 * A later plan, whatever became of it, replaces an earlier one (the user was planning
 * again), so a rejected or still-pending latest plan means none is in force.
 */
export function findAcceptedPlan(messages: ChatMessage[]): AcceptedPlan | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    const call = [...(m.toolCalls ?? [])].reverse().find((c) => c.name === PRESENT_PLAN_TOOL)
    if (!call) continue
    const result = messages.find((r) => r.role === 'tool' && r.toolCallId === call.id)?.content ?? ''
    if (!result.startsWith(ACCEPTED)) return null
    const args = call.arguments
    const body = acceptedBody(result, typeof args.plan === 'string' ? args.plan : '')
    return {
      index: i,
      title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : 'Plan',
      files: strList(args.files),
      checks: planVerifySteps({ verify: strList(args.verify), body })
    }
  }
  return null
}

/** A request to leave the checks out ("don't run the tests", "skip the build"). */
const SKIP = /\b(don'?t|do not|no need to|skip|without)\b[^.\n]{0,40}\b(tests?|checks?|verif\w*|builds?|run(ning)? it)\b/i

const CODE_KINDS: ReadonlySet<CheckKind> = new Set(['test', 'typecheck', 'build', 'lint', 'http', 'browser', 'verify'])

function counts(c: ReceiptCheck): boolean {
  return c.ok === true || (c.kind === 'http' && c.unknown === 'http-status-unchecked')
}

function matches(c: ReceiptCheck, kind: RequiredCheck): boolean {
  return kind === 'any' ? CODE_KINDS.has(c.kind) : c.kind === kind
}

/**
 * The checks a plan step stands for. A step that reads as a command ("node test_app.mjs",
 * "npm run build") is classified the way run_shell's commands are, so it is matched by
 * what that command does; otherwise by the words it uses.
 */
function stepKinds(step: string): { kinds: RequiredCheck[]; command?: string[] } {
  const command = step.replace(/^`|`$/g, '').trim()
  const kind = classifyCommand(command).kind
  return kind && CODE_KINDS.has(kind)
    ? { kinds: [kind], command: command.split(/\s+/) }
    : { kinds: checksNamedBy(step) }
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '')

/** Inputs for {@link planProgress}. */
export interface PlanProgressInput {
  plan: AcceptedPlan
  /** When it was accepted, if known: a planned file changed on disk since counts as done. */
  acceptedAt?: number
  /** Every receipt since the plan, this turn's last. */
  receipts: TurnReceipt[]
  workspace: string
  /** This turn's request, read for a request to skip the checks. */
  userText: string
  /** Injected for tests. */
  stat?: (absPath: string) => { mtimeMs: number } | undefined
}

/** How an accepted plan stands. Pure apart from the file stats. */
export function planProgress(input: PlanProgressInput): PlanProgress {
  const { plan, acceptedAt, receipts } = input
  const stat =
    input.stat ??
    ((p: string) => {
      try {
        return statSync(p)
      } catch {
        return undefined
      }
    })
  const changed = new Set(receipts.flatMap((r) => r.filesChanged.map(norm)))
  const pending = plan.files.filter((f) => {
    if (changed.has(norm(f))) return false
    // A file a shell command wrote (a scaffolder, `cat > f`) never passes the write
    // tools, so it is counted as done if it changed on disk after the plan was accepted.
    const s = acceptedAt === undefined ? undefined : stat(join(input.workspace, f))
    return !(s && s.mtimeMs >= acceptedAt!)
  })
  const allChecks = receipts.flatMap((r) => r.checks)
  const skip = SKIP.test(input.userText)
  const checks: PlanCheckStatus[] = plan.checks.map((step) => {
    const { kinds, command } = stepKinds(step)
    // A step written as a command is backed only by a run of that command (every word
    // of it appears in what ran): "pytest" isn't backed by `node test_app.mjs` failing.
    const relevant = command ? allChecks.filter((c) => command.every((w) => c.label.includes(w))) : allChecks
    const passed = kinds.every((k) => relevant.some((c) => matches(c, k) && counts(c)))
    if (passed) return { step, status: 'passed' }
    if (skip) return { step, status: 'skipped' }
    // A step that names no particular check ("add a todo and see it listed") is never
    // "ran, nothing passed" because some other kind of check failed.
    const ran = kinds.some((k) => k !== 'any' && relevant.some((c) => matches(c, k)))
    return { step, status: ran ? 'failed' : 'not-run' }
  })
  return {
    title: plan.title.length > 60 ? `${plan.title.slice(0, 59)}…` : plan.title,
    ...(acceptedAt !== undefined ? { acceptedAt } : {}),
    filesTotal: plan.files.length,
    filesPending: pending.slice(0, 10),
    filesPendingCount: pending.length,
    checks,
    complete:
      (plan.files.length > 0 || plan.checks.length > 0) && pending.length === 0 && checks.every((c) => c.status === 'passed')
  }
}

/** How many user turns are left before an untouched plan stops being carried. */
const PLAN_TURNS_WITHOUT_PROGRESS = 5

/** Real user turns after `index` (Houston's own notes don't count). */
function userTurnsSince(messages: ChatMessage[], index: number): number {
  return messages.slice(index + 1).filter((m) => m.role === 'user' && !m.content.startsWith(SYSTEM_NOTE_PREFIX)).length
}

/**
 * Whether the plan is still being carried out, so its progress belongs on this turn's
 * receipt: not once a turn has already shown it complete, and not when the chat has
 * moved on (several turns since it was accepted, and this one touched none of its files).
 */
export function planStillOpen(
  messages: ChatMessage[],
  plan: AcceptedPlan,
  priorReceipts: TurnReceipt[],
  thisTurn: TurnReceipt | null
): boolean {
  if (priorReceipts.some((r) => r.plan?.complete)) return false
  if (userTurnsSince(messages, plan.index) <= PLAN_TURNS_WITHOUT_PROGRESS) return true
  const planned = new Set(plan.files.map(norm))
  return (thisTurn?.filesChanged ?? []).some((f) => planned.has(norm(f)))
}
