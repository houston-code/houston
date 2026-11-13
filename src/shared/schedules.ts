import type { ApprovalPolicy } from './types'
import type { ReasoningEffort } from './agent'

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
  lastResult?: 'ok' | 'error'
  lastError?: string
  createdAt: number
  paused?: boolean
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
