import { realpathSync, statSync } from 'node:fs'
import type { ipcMain } from 'electron'
import { IPC } from '@shared/constants'
import { isApprovalPolicy, type ProviderConfig } from '@shared/types'
import {
  MAX_SCHEDULE_NAME,
  MAX_SCHEDULE_PROMPT,
  type SchedulePreview,
  type ScheduleResult,
  type ScheduleView
} from '@shared/schedules'
import { describeSpec, nextOccurrence, parseScheduleSpec } from './agent/schedule-spec'
import type { ScheduledRunInput } from './agent/scheduler'
import type { SchedulerService } from './schedulerService'
import { getSettings } from './store'

/** The real directory a path names, or null when it isn't one. */
function realDir(path: string): string | null {
  try {
    const real = realpathSync(path)
    return statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/**
 * Check a create request from the renderer and turn it into the scheduler's input,
 * or say what is wrong. Everything is re-validated here: the folder must exist, the
 * provider must be configured, the policy must be a known one. The spec itself is
 * checked by the service, which throws the parser's message.
 */
export function scheduleInputFrom(
  raw: unknown,
  deps: { providers: ProviderConfig[]; realDir?: (p: string) => string | null }
): ScheduledRunInput | string {
  if (!raw || typeof raw !== 'object') return 'Missing details.'
  const r = raw as Record<string, unknown>
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string).trim() : '')
  const prompt = str('prompt')
  if (!prompt) return 'Write the task each run starts with.'
  if (prompt.length > MAX_SCHEDULE_PROMPT) return `The task is too long (at most ${MAX_SCHEDULE_PROMPT} characters).`
  const name = (str('name') || prompt.split('\n', 1)[0]).slice(0, MAX_SCHEDULE_NAME).trim()
  const spec = str('spec')
  if (!spec) return 'Say when it runs, for example "weekdays at 09:00".'
  const folder = str('workspace')
  const workspace = folder ? (deps.realDir ?? realDir)(folder) : null
  if (!workspace) return 'Choose a folder that exists.'
  const provider = deps.providers.find((p) => p.id === str('providerId'))
  if (!provider) return 'Choose a configured model.'
  const model = str('model')
  if (!model || model.length > 200) return 'Choose a model.'
  if (!isApprovalPolicy(r.approvalPolicy)) return 'Choose an approval mode.'
  return { name, spec, prompt, workspace, providerId: provider.id, model, approvalPolicy: r.approvalPolicy }
}

/** What a typed spec means right now. */
export function previewSchedule(spec: unknown, now: Date = new Date()): SchedulePreview {
  if (typeof spec !== 'string' || !spec.trim()) return { ok: false, error: 'Say when it runs.' }
  const parsed = parseScheduleSpec(spec.trim(), now)
  if (typeof parsed === 'string') return { ok: false, error: parsed }
  return { ok: true, spec: describeSpec(parsed), nextRunAt: nextOccurrence(parsed, now) }
}

/** Settings > Scheduled runs, over the running scheduler service. */
export function registerScheduleIpc(handle: typeof ipcMain.handle, scheduler: SchedulerService): void {
  handle(IPC.schedulesList, (): ScheduleView[] => scheduler.list())
  handle(IPC.schedulesPreview, (_e, spec: unknown): SchedulePreview => previewSchedule(spec))
  handle(IPC.schedulesCreate, (_e, request: unknown): ScheduleResult => {
    const input = scheduleInputFrom(request, { providers: getSettings().providers })
    if (typeof input === 'string') return { ok: false, error: input }
    try {
      return { ok: true, schedule: scheduler.create(input) }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  handle(IPC.schedulesSetPaused, (_e, id: unknown, paused: unknown): ScheduleResult => {
    if (typeof id !== 'string' || typeof paused !== 'boolean') return { ok: false, error: 'Unknown scheduled run.' }
    const s = scheduler.setPaused(id, paused)
    return s ? { ok: true, schedule: s } : { ok: false, error: 'That scheduled run no longer exists.' }
  })
  handle(IPC.schedulesRunNow, async (_e, id: unknown): Promise<ScheduleResult> => {
    if (typeof id !== 'string') return { ok: false, error: 'Unknown scheduled run.' }
    try {
      await scheduler.runNow(id)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })
  handle(IPC.schedulesDelete, (_e, id: unknown): ScheduleResult =>
    typeof id === 'string' && scheduler.cancel(id) ? { ok: true } : { ok: false, error: 'That scheduled run no longer exists.' }
  )
}
