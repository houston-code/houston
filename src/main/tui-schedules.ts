import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { APPROVAL_POLICY_LABEL, parseApprovalPolicy, type AppSettings, type ApprovalPolicy } from '@shared/types'
import { scheduleLastRunFailed, scheduleLastRunText, type ScheduleView } from '@shared/schedules'
import { resolveModelArg } from '@shared/modelArg'
import type { ScheduledRunInfo, ScheduledRunInput } from './agent/scheduler'
import { previewSchedule, scheduleInputFrom } from './scheduleIpc'
import type { Painter } from './tui'
import { stripControlChars } from './tui-wrap'

/**
 * /schedule in the terminal: the desktop's Settings > Scheduled runs page (list,
 * pause, resume, run now, delete, create) over the same scheduler service and the
 * same validation, so a schedule made here is the one the app shows.
 */

export type ScheduleOp =
  | { op: 'list' }
  | { op: 'show' | 'pause' | 'resume' | 'run' | 'delete'; index: number }
  | { op: 'add' }
  | { op: 'usage' }

export const SCHEDULE_USAGE =
  'usage: /schedule   ·   /schedule add   ·   /schedule show|pause|resume|run|delete <n>'

/** Parse the argument of /schedule (and /schedules). Bare command → list. */
export function parseScheduleArgs(arg: string): ScheduleOp {
  const [verb, n, extra] = arg.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!verb || verb === 'list' || verb === 'ls') return n ? { op: 'usage' } : { op: 'list' }
  if (verb === 'add' || verb === 'new' || verb === 'create') return n ? { op: 'usage' } : { op: 'add' }
  const op =
    verb === 'show' || verb === 'view'
      ? 'show'
      : verb === 'pause'
        ? 'pause'
        : verb === 'resume' || verb === 'unpause'
          ? 'resume'
          : verb === 'run' || verb === 'run-now'
            ? 'run'
            : verb === 'delete' || verb === 'remove' || verb === 'rm'
              ? 'delete'
              : null
  const index = Number(n)
  if (op && !extra && /^\d+$/.test(n ?? '') && index >= 1) return { op, index }
  return { op: 'usage' }
}

/** The scheduler operations /schedule uses (the service the terminal host wired). */
export interface ScheduleBackend {
  list: () => ScheduleView[]
  create: (input: ScheduledRunInput) => ScheduledRunInfo
  cancel: (id: string) => boolean
  setPaused: (id: string, paused: boolean) => ScheduledRunInfo | null
  runNow: (id: string) => Promise<void>
}

export interface ScheduleCommandDeps {
  /** Absent where no scheduler is wired: the command says so. */
  scheduler?: ScheduleBackend
  getSettings: () => AppSettings
  readLine: (prompt: string, opts?: { discardPending?: boolean }) => Promise<string | null>
  out: (text: string) => void
  /** The terminal's folder, the default folder for a new schedule. */
  cwd: string
  /** This chat's model, the default model for a new schedule. */
  providerId?: string
  model?: string
  now?: () => number
}

const clean = (s: string): string => stripControlChars(s)

/** "in 3 h", "in 12 min", "in 2 days", or "now" for a time that has passed. */
function until(at: number, now: number): string {
  const ms = at - now
  if (ms <= 60_000) return 'now'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `in ${min} min`
  const h = Math.round(min / 60)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(h / 24)} days`
}

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/** The last folder name of a path, for the one-line summary. */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** The numbered list /schedule prints. */
export function renderScheduleList(list: ScheduleView[], paint: Painter, now: number): string {
  if (!list.length) {
    return paint('· no scheduled runs. /schedule add creates one; the agent can also schedule one for you.', 'dim')
  }
  const lines = [paint('Scheduled runs:', 'bold')]
  list.forEach((s, i) => {
    const next = s.paused
      ? paint('paused', 'yellow')
      : s.nextRunAt === null
        ? paint('no more runs', 'dim')
        : `next ${until(s.nextRunAt, now)} (${when(s.nextRunAt)})`
    lines.push(`  ${paint(String(i + 1).padStart(2), 'cyan')}. ${clean(s.name)}  ${paint(clean(s.spec), 'dim')}  ${next}`)
    const last = scheduleLastRunText(s)
    const meta = [
      `in ${clean(folderName(s.workspace))}`,
      `${clean(s.providerId)}/${clean(s.model)}`,
      APPROVAL_POLICY_LABEL[s.approvalPolicy] ?? s.approvalPolicy,
      last ? `last run ${clean(last)}` : ''
    ].filter(Boolean)
    lines.push(`      ${paint(meta.join(' · '), scheduleLastRunFailed(s) ? 'yellow' : 'dim')}`)
  })
  lines.push(paint(SCHEDULE_USAGE.replace('usage: ', ''), 'dim'))
  return lines.join('\n')
}

const isYes = (answer: string | null): boolean => /^\s*y(es)?\s*$/i.test(answer ?? '')

/** Run a parsed /schedule. */
export async function runScheduleCommand(op: ScheduleOp, deps: ScheduleCommandDeps, paint: Painter): Promise<void> {
  if (op.op === 'usage') return void deps.out(paint(`· ${SCHEDULE_USAGE}\n`, 'dim'))
  const scheduler = deps.scheduler
  if (!scheduler) return void deps.out(paint('· scheduled runs are unavailable here\n', 'dim'))
  const now = deps.now?.() ?? Date.now()
  if (op.op === 'add') return addSchedule(scheduler, deps, paint)
  const list = scheduler.list()
  if (op.op === 'list') return void deps.out(`${renderScheduleList(list, paint, now)}\n`)

  const s = list[op.index - 1]
  if (!s) return void deps.out(paint(`· no scheduled run ${op.index}; /schedule lists them\n`, 'yellow'))
  const name = clean(s.name)
  switch (op.op) {
    case 'show': {
      deps.out(`${renderScheduleList([s], paint, now).split('\n').slice(1, 3).join('\n')}\n`)
      deps.out(paint(`  folder: ${clean(s.workspace)}\n  task:\n`, 'dim'))
      deps.out(`${s.prompt.split('\n').map((l) => `    ${clean(l)}`).join('\n')}\n`)
      return
    }
    case 'pause':
    case 'resume': {
      const paused = op.op === 'pause'
      if (!!s.paused === paused) return void deps.out(paint(`· ${name} is already ${paused ? 'paused' : 'running on schedule'}\n`, 'dim'))
      const after = scheduler.setPaused(s.id, paused)
      if (!after) return void deps.out(paint('· that scheduled run no longer exists\n', 'yellow'))
      const next = after.nextRunAt !== null ? `; next run ${when(after.nextRunAt)}` : ''
      deps.out(paint(paused ? `· paused ${name}\n` : `· resumed ${name}${next}\n`, 'dim'))
      return
    }
    case 'run': {
      try {
        await scheduler.runNow(s.id)
        deps.out(paint(`· started ${name} now, in the background. /resume opens its chat; its next planned run is unchanged.\n`, 'dim'))
      } catch (e) {
        deps.out(paint(`· could not start ${name}: ${clean((e as Error).message)}\n`, 'yellow'))
      }
      return
    }
    case 'delete': {
      const ok = await deps.readLine(`Delete the scheduled run "${name}"? Its past chats stay. [y/N] `, { discardPending: true })
      if (!isYes(ok)) return void deps.out(paint('· nothing changed\n', 'dim'))
      deps.out(paint(scheduler.cancel(s.id) ? `· deleted ${name}\n` : '· that scheduled run no longer exists\n', 'dim'))
      return
    }
  }
}

/** A typed folder: `~` for home, relative to the terminal's folder. */
function expandFolder(input: string, cwd: string): string {
  const t = input.trim()
  if (t === '~' || t.startsWith('~/')) return resolve(homedir(), t.slice(2))
  return isAbsolute(t) ? t : resolve(cwd, t)
}

/**
 * /schedule add: one question per field, with the desktop form's defaults (this
 * folder, this chat's model, plan mode), then the same validation the desktop's
 * create goes through, and a confirmation before anything is saved. Ctrl-D cancels.
 */
async function addSchedule(scheduler: ScheduleBackend, deps: ScheduleCommandDeps, paint: Painter): Promise<void> {
  const cancelled = (): void => deps.out(paint('· cancelled, nothing saved\n', 'dim'))
  deps.out(paint('New scheduled run. Each run starts a background chat with the task below. Ctrl-D cancels.\n', 'bold'))

  let spec: string
  let preview: string
  for (;;) {
    const ans = await deps.readLine(paint('when (e.g. every 30m, weekdays at 09:00, daily at 18:30) › ', 'green'))
    if (ans === null || !ans.trim()) return cancelled()
    const p = previewSchedule(ans, new Date(deps.now?.() ?? Date.now()))
    if (!p.ok) {
      deps.out(paint(`· ${clean(p.error)}\n`, 'yellow'))
      continue
    }
    spec = ans.trim()
    preview = `${p.spec}${p.nextRunAt !== null ? `, first run ${when(p.nextRunAt)}` : ''}`
    deps.out(paint(`· ${clean(preview)}\n`, 'dim'))
    break
  }

  const prompt = await deps.readLine(paint('task (what each run should do) › ', 'green'))
  if (prompt === null || !prompt.trim()) return cancelled()

  const defaultName = prompt.trim().split('\n', 1)[0].slice(0, 80)
  const nameAns = await deps.readLine(paint(`name (Enter for "${clean(defaultName)}") › `, 'green'))
  if (nameAns === null) return cancelled()

  const folderAns = await deps.readLine(paint(`folder (Enter for ${clean(deps.cwd)}) › `, 'green'))
  if (folderAns === null) return cancelled()
  const workspace = folderAns.trim() ? expandFolder(folderAns, deps.cwd) : deps.cwd

  const settings = deps.getSettings()
  const here = deps.providerId && deps.model ? `${deps.providerId}/${deps.model}` : ''
  const modelAns = await deps.readLine(paint(`model (${here ? `Enter for ${clean(here)}` : 'provider/model'}) › `, 'green'))
  if (modelAns === null) return cancelled()
  const picked = modelAns.trim()
    ? resolveModelArg(modelAns.trim(), settings)
    : deps.providerId && deps.model
      ? { providerId: deps.providerId, model: deps.model }
      : null
  if (!picked) return void deps.out(paint('· choose a configured model, as provider/model (/model lists them); nothing saved\n', 'yellow'))

  const policyAns = await deps.readLine(paint('approval mode: plan, ask, auto, full (Enter for plan) › ', 'green'))
  if (policyAns === null) return cancelled()
  const policy: ApprovalPolicy | null = policyAns.trim() ? parseApprovalPolicy(policyAns) : 'plan'
  if (!policy) return void deps.out(paint('· approval mode is plan, ask, auto, or full; nothing saved\n', 'yellow'))

  const input = scheduleInputFrom(
    { name: nameAns, spec, prompt, workspace, providerId: picked.providerId, model: picked.model, approvalPolicy: policy },
    { providers: settings.providers }
  )
  if (typeof input === 'string') return void deps.out(paint(`· ${input} Nothing saved.\n`, 'yellow'))

  deps.out(
    `\n${paint('scheduled run:', 'dim')} ${clean(input.name)}\n` +
      paint(`  ${clean(preview)}\n  in ${clean(input.workspace)} with ${clean(input.providerId)}/${clean(input.model)}, ${APPROVAL_POLICY_LABEL[input.approvalPolicy]}\n`, 'dim')
  )
  if (input.approvalPolicy === 'full-auto') {
    deps.out(paint('  Full auto: each run edits and runs commands (sandboxed) with no one there to approve.\n', 'yellow'))
  }
  const ok = await deps.readLine('Create this scheduled run? [y/N] ', { discardPending: true })
  if (!isYes(ok)) return void deps.out(paint('· not created\n', 'dim'))
  try {
    const created = scheduler.create(input)
    const next = created.nextRunAt !== null ? `; next run ${when(created.nextRunAt)}` : ''
    deps.out(paint(`· created ${clean(created.name)}${next}. Runs fire while Houston is open (the app, a terminal session, or the schedule daemon).\n`, 'dim'))
  } catch (e) {
    deps.out(paint(`· ${clean((e as Error).message)} Nothing saved.\n`, 'yellow'))
  }
}
