import type { ApprovalPolicy } from '@shared/types'

/**
 * Injection seam for scheduled (recurring or one-shot) agent runs — the engine
 * side of the `schedule_run` / `list_scheduled_runs` / `cancel_scheduled_run`
 * tools.
 *
 * A scheduled run is a persisted trigger: at each occurrence of its spec the
 * host fires a fresh background session seeded with the stored prompt (through
 * the same spawn path as `spawn_session`, so fired runs show up as ordinary
 * conversations and inherit the concurrency cap). The store + timer service
 * lives in the shell (`src/main/schedulerService.ts`); hosts wire it at startup
 * via {@link setSchedulerBackend}, mirroring `spawn.ts`. A host that wires no
 * backend drops the three tools from the schema set — see
 * {@link isSchedulerConfigured}.
 *
 * Schedules only fire while Houston is running: this is an in-app scheduler,
 * not an OS-level cron. The tools' descriptions say so, and the docs repeat it.
 */

/** Tool names — single source, imported by the loop's schema filter. */
export const SCHEDULE_TOOL_NAMES = [
  'schedule_run',
  'list_scheduled_runs',
  'cancel_scheduled_run'
] as const

/** What the tool hands the backend, with the run-scoped fields filled in by the loop. */
export interface ScheduledRunInput {
  /** Short human name; becomes each fired session's title. */
  name: string
  /** Recurrence spec, e.g. "every 30m" / "daily at 09:00" (validated by the backend). */
  spec: string
  /** The self-contained task each fired session starts with. */
  prompt: string
  /** Workspace the fired sessions run in (the creating run's workspace). */
  workspace: string
  /** Provider + model the fired sessions use (inherited from the creating run). */
  providerId: string
  model: string
  /**
   * Approval policy fired sessions start under — inherited from the creating run
   * so a schedule is never more permissive than the chat that created it.
   */
  approvalPolicy: ApprovalPolicy
}

/** A stored schedule, as reported back to the model and shown in listings. */
export interface ScheduledRunInfo extends ScheduledRunInput {
  id: string
  /** Epoch ms of the next planned fire; null once a one-shot has fired. */
  nextRunAt: number | null
  /** Epoch ms of the most recent fire, if any. */
  lastFiredAt?: number
  /** Whether the most recent fire started its session cleanly. */
  lastResult?: 'ok' | 'error'
  /** The most recent fire's failure, when lastResult is 'error'. */
  lastError?: string
  createdAt: number
}

/** The shell-side capability injected at startup. */
export interface SchedulerBackend {
  /** Validate + persist a schedule and arm its timer. Throws with an actionable message on a bad spec. */
  create(input: ScheduledRunInput): ScheduledRunInfo
  list(): ScheduledRunInfo[]
  /** Remove a schedule. False when the id is unknown (already cancelled / mistyped). */
  cancel(id: string): boolean
}

let backend: SchedulerBackend | null = null

/** Wire the real scheduler backend. Call once during startup, before any run. */
export function setSchedulerBackend(impl: SchedulerBackend): void {
  backend = impl
}

/** Test-only: clear the wired backend so a suite can restore an unconfigured state. */
export function resetSchedulerBackend(): void {
  backend = null
}

/**
 * Whether a scheduler backend has been wired. The loop uses this to drop the
 * schedule tools from the toolset and prompt on hosts that didn't wire one,
 * mirroring `spawn_session` / `view_localhost`.
 */
export function isSchedulerConfigured(): boolean {
  return backend !== null
}

function requireBackend(): SchedulerBackend {
  if (!backend) {
    throw new Error(
      'Scheduler backend not configured — call setSchedulerBackend() during startup (see src/main/schedulerService.ts).'
    )
  }
  return backend
}

export function scheduleCreate(input: ScheduledRunInput): ScheduledRunInfo {
  return requireBackend().create(input)
}

export function scheduleList(): ScheduledRunInfo[] {
  return requireBackend().list()
}

export function scheduleCancel(id: string): boolean {
  return requireBackend().cancel(id)
}
