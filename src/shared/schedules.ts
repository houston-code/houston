import type { ApprovalPolicy } from './types'
import type { ReasoningEffort, RunLimitReason } from './agent'

/**
 * Settings > Scheduled runs: the renderer's view of the scheduler service's store
 * (src/main/schedulerService.ts), and what it sends to create one.
 */

export interface ScheduleView {
  id: string
  name: string
  /** Normalized recurrence, e.g. "every 30m", "weekdays at 09:30". */
  spec: string
  prompt: string
  workspace: string
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
  reasoningEffort?: ReasoningEffort
  /** Epoch ms of the next planned run; null when it has none (a spent one-shot). */
  nextRunAt: number | null
  lastFiredAt?: number
  /** `running` while the last fire's run is in flight, then how it ended. */
  lastResult?: ScheduleRunResult
  lastLimit?: RunLimitReason
  lastError?: string
  /** The chat the last fire started (unset when it could not start). */
  lastRunConversationId?: string
  createdAt: number
  paused?: boolean
}

export type ScheduleRunResult = 'running' | 'ok' | 'error' | 'limit' | 'stopped'

/**
 * How a schedule's last run went, in plain words, or null when that isn't known
 * (never fired, or fired before outcomes were kept). Shared by Settings and the
 * agent's listing so they read the same.
 */
export function scheduleLastRunText(
  s: Pick<ScheduleView, 'lastResult' | 'lastLimit' | 'lastError' | 'lastRunConversationId'>
): string | null {
  switch (s.lastResult) {
    case 'running':
      return 'still running'
    case 'ok':
      return 'finished'
    case 'stopped':
      return 'was stopped before it finished'
    case 'limit':
      return s.lastLimit === 'stalled'
        ? 'stopped because it stalled without making progress'
        : s.lastLimit === 'max-output'
          ? 'was cut off at the model’s output limit'
          : 'stopped at the step limit'
    case 'error': {
      const why = s.lastError ?? 'unknown error'
      return s.lastRunConversationId ? `failed (${why})` : `couldn't start (${why})`
    }
    default:
      return null
  }
}

/** Whether a schedule's last run ended without finishing its work. */
export function scheduleLastRunFailed(s: Pick<ScheduleView, 'lastResult'>): boolean {
  return s.lastResult === 'error' || s.lastResult === 'limit' || s.lastResult === 'stopped'
}

export interface ScheduleCreateRequest {
  name: string
  spec: string
  prompt: string
  workspace: string
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

export type ScheduleResult = { ok: true; schedule?: ScheduleView } | { ok: false; error: string }

/** What a typed schedule means: its normalized form and next run, or why it isn't one. */
export type SchedulePreview = { ok: true; spec: string; nextRunAt: number | null } | { ok: false; error: string }

/** Longest prompt a scheduled run may store. */
export const MAX_SCHEDULE_PROMPT = 20_000
/** Longest schedule name. */
export const MAX_SCHEDULE_NAME = 80
