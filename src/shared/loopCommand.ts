import { MAX_SCHEDULE_NAME, MAX_SCHEDULE_PROMPT, scheduleLastRunText, type ScheduleView } from './schedules'

/**
 * `/loop [interval] <prompt>` and `/schedule [cancel <n>]`: the user's own way into the
 * scheduler the agent reaches with schedule_run / list_scheduled_runs /
 * cancel_scheduled_run. Both clients parse and list with these, then hand the result
 * to the same scheduler store, which validates the spec with the one spec parser
 * (src/main/agent/schedule-spec.ts) and says what is wrong in its own words.
 */

/** How often `/loop <prompt>` runs when no interval is given. */
export const LOOP_DEFAULT_SPEC = 'every 10m'

const UNIT = '(?:m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)'
const TIME = '\\d{1,2}:\\d{2}'

/** The schedule forms `/loop` reads at the start of its argument, longest first. */
const LEADING_SPECS: { re: RegExp; spec: (m: RegExpExecArray) => string }[] = [
  { re: new RegExp(`^(every\\s+[\\d.]+\\s*${UNIT})\\s+`, 'i'), spec: (m) => m[1] },
  { re: new RegExp(`^((?:daily|weekdays)\\s+at\\s+${TIME})\\s+`, 'i'), spec: (m) => m[1] },
  { re: new RegExp(`^(weekly\\s+on\\s+[a-z]+\\s+at\\s+${TIME})\\s+`, 'i'), spec: (m) => m[1] },
  // The short form: `/loop 10m check CI` is "every 10m".
  { re: new RegExp(`^([\\d.]+\\s?${UNIT})\\s+`, 'i'), spec: (m) => `every ${m[1]}` }
]

const INTERVAL_ONLY = new RegExp(`^(?:every\\s+)?[\\d.]+\\s*${UNIT}$`, 'i')

export const LOOP_USAGE = 'Usage: /loop [interval] <prompt>, for example /loop 10m check CI (the interval defaults to 10m)'

/**
 * Read `/loop`'s argument: an optional leading schedule (`10m`, `every 2 hours`,
 * `daily at 09:00`, `weekdays at 09:30`, `weekly on monday at 09:30`), then the prompt
 * each run starts with. Whether the schedule is a valid one (the 5 minute minimum,
 * hours 0-23) is the scheduler's to say.
 */
export function parseLoopArgs(arg: string): { ok: true; spec: string; task: string } | { ok: false; error: string } {
  const text = arg.trim()
  // An interval with nothing after it (`/loop 10m`) has no prompt to run.
  if (!text || INTERVAL_ONLY.test(text)) return { ok: false, error: LOOP_USAGE }
  let spec = LOOP_DEFAULT_SPEC
  let prompt = text
  for (const form of LEADING_SPECS) {
    const m = form.re.exec(text)
    if (m) {
      spec = form.spec(m).replace(/\s+/g, ' ')
      prompt = text.slice(m[0].length).trim()
      break
    }
  }
  if (!prompt) return { ok: false, error: LOOP_USAGE }
  if (prompt.length > MAX_SCHEDULE_PROMPT) return { ok: false, error: `The prompt is too long (at most ${MAX_SCHEDULE_PROMPT} characters).` }
  return { ok: true, spec, task: prompt }
}

/** A schedule's name from its prompt: the first line, cut to fit. */
export function loopScheduleName(prompt: string): string {
  const first = (prompt.split('\n', 1)[0] ?? '').trim()
  return first.length > MAX_SCHEDULE_NAME ? `${first.slice(0, MAX_SCHEDULE_NAME - 1)}…` : first
}

export const SCHEDULE_USAGE = 'Usage: /schedule lists the scheduled runs; /schedule cancel <n> cancels one'

/** What `/schedule` was asked to do. */
export type ScheduleOp = { op: 'list' } | { op: 'cancel'; index: number } | { op: 'usage' }

export function parseScheduleArgs(arg: string): ScheduleOp {
  const a = arg.trim()
  if (!a || /^(list|ls)$/i.test(a)) return { op: 'list' }
  const m = /^(?:cancel|rm|remove|delete)\s+#?(\d+)$/i.exec(a)
  if (m && Number(m[1]) >= 1) return { op: 'cancel', index: Number(m[1]) }
  return { op: 'usage' }
}

/** The schedules in the order `/schedule` numbers them: oldest first, so a number stays put as new ones are added. */
export function numberedSchedules<T extends Pick<ScheduleView, 'createdAt' | 'id'>>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A clock time for a listing: today's runs as HH:MM, later ones with the date. */
export function scheduleWhen(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const pad = (x: number): string => String(x).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}

/**
 * One line per scheduled run, numbered as `/schedule cancel <n>` reads them:
 * `1. check CI: every 10m, next at 14:30, last run finished (~/code/app)`. The name and
 * folder come from the store and may hold anything, so callers print them sanitized.
 */
export function scheduleListLines(
  list: readonly Pick<
    ScheduleView,
    'id' | 'name' | 'spec' | 'workspace' | 'nextRunAt' | 'createdAt' | 'paused' | 'lastResult' | 'lastLimit' | 'lastError' | 'lastRunConversationId'
  >[],
  now: number,
  folder: (workspace: string) => string = (w) => w
): string[] {
  return numberedSchedules(list).map((s, i) => {
    const parts = [s.spec]
    if (s.paused) parts.push('paused')
    else if (s.nextRunAt !== null) parts.push(`next at ${scheduleWhen(s.nextRunAt, now)}`)
    else parts.push('done')
    const last = scheduleLastRunText(s)
    if (last) parts.push(`last run ${last}`)
    return `${i + 1}. ${s.name}: ${parts.join(', ')} (${folder(s.workspace)})`
  })
}
