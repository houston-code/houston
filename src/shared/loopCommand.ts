import { MAX_SCHEDULE_NAME, MAX_SCHEDULE_PROMPT } from './schedules'

/**
 * `/loop [interval] <prompt>`: the user's own quick way into the scheduler the agent
 * reaches with schedule_run (and that the terminal's /schedule and the desktop's
 * Settings > Scheduled runs manage). Both clients parse with these, then hand the
 * result to the same scheduler store, which validates the spec with the one spec parser
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

/** A clock time for a listing: today's runs as HH:MM, later ones with the date. */
export function scheduleWhen(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  const pad = (x: number): string => String(x).padStart(2, '0')
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`
}
