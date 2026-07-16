/**
 * Recurrence specs for scheduled agent runs.
 *
 * The scheduler service stores a human-typed spec string ("every 15m",
 * "weekdays at 09:30") and needs two things from it: a validated, structured
 * form it can persist, and the next fire time relative to an arbitrary "after"
 * instant. Both live here as pure functions so the scheduler's timer plumbing
 * stays untangled from the calendar math and the math is unit-testable without
 * fake timers.
 *
 * Design choices worth noting:
 *  - `parseScheduleSpec` returns an error STRING instead of throwing. The spec
 *    comes from a user (or the model relaying one), so the failure mode is
 *    "show them what was wrong and what's accepted", not a stack trace. Every
 *    error is written to be surfaced verbatim.
 *  - All calendar forms use LOCAL time. People say "daily at 09:30" meaning
 *    their wall clock; constructing candidates from local date components
 *    (rather than adding fixed millisecond offsets) keeps that true across DST
 *    transitions.
 *  - Nothing here reads the clock. Every function that needs "now" takes it as
 *    a parameter, so occurrence math is deterministic under test and the
 *    scheduler owns the single source of time.
 */

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Smallest allowed interval, so a runaway spec ("every 1m", or a typo like
 * "every 0.1h") can't fire the scheduler in a tight loop.
 */
export const MIN_INTERVAL_MS = 5 * MINUTE_MS

/**
 * Largest allowed interval. Anything past a year is almost certainly a typo
 * (wrong unit), and a fire time that far out silently outlives most installs.
 */
const MAX_INTERVAL_MS = 365 * DAY_MS

/** Parsed recurrence, discriminated by kind. */
export type ScheduleSpec =
  | { kind: 'interval'; everyMs: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | { kind: 'once'; at: number }

/**
 * The catalog shown on any unrecognized spec. One compact line per form so the
 * user can pattern-match their intent against it without reading docs.
 */
const SUPPORTED_FORMS = [
  '"every <N><unit>" where unit is minutes/hours/days, e.g. "every 15m" or "every 2 hours" (minimum 5 minutes, maximum 365 days)',
  '"daily at HH:MM" (24-hour), e.g. "daily at 09:30"',
  '"weekdays at HH:MM" (Monday through Friday), e.g. "weekdays at 09:30"',
  '"weekly on <day> at HH:MM", e.g. "weekly on monday at 09:30"',
  '"once at YYYY-MM-DD HH:MM" (local time, "T" separator also accepted), e.g. "once at 2026-07-16 09:30"'
].join('\n  ')

/** Sunday-first to line up with JS `Date.getDay()` (0=Sunday .. 6=Saturday). */
const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const

/**
 * Map a weekday token to its `getDay()` index. Accepts the full name or the
 * conventional 3-letter abbreviation, nothing looser: fuzzy prefixes ("tues",
 * "thurs") would silently accept typos we can't distinguish from mistakes.
 */
function parseWeekday(token: string): number | null {
  for (let day = 0; day < DAY_NAMES.length; day++) {
    const name = DAY_NAMES[day].toLowerCase()
    if (token === name || token === name.slice(0, 3)) return day
  }
  return null
}

/**
 * Validate an HH:MM pair captured by a spec regex. The regexes only admit
 * digits, so range (not shape) is the concern here; out-of-range values get a
 * message naming the valid range rather than a generic parse failure.
 */
function parseTime(hourStr: string, minuteStr: string): { hour: number; minute: number } | string {
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  if (hour > 23) return `Invalid hour "${hourStr}": hours must be 0-23 (24-hour clock).`
  if (minute > 59) return `Invalid minute "${minuteStr}": minutes must be 0-59.`
  return { hour, minute }
}

/** Two-digit zero-padding for HH:MM / date rendering. */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Parse a spec string into a `ScheduleSpec`, or a human-readable error string
 * describing the problem. Never throws: the result is meant to be relayed to
 * whoever typed the spec.
 *
 * `now` is only consulted for the 'once' form, to reject a fire time that has
 * already passed at creation time (a 'once' in the past would otherwise be
 * accepted and then never fire, which reads as a silent failure). Callers that
 * are re-parsing a stored spec can omit it.
 */
export function parseScheduleSpec(spec: string, now?: Date): ScheduleSpec | string {
  const s = spec.trim().toLowerCase().replace(/\s+/g, ' ')

  const every = /^every ([\d.]+) ?(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(
    s
  )
  if (every) {
    const count = Number(every[1])
    if (!Number.isFinite(count) || count <= 0) {
      return `Invalid interval count "${every[1]}": it must be a positive number, e.g. "every 15m".`
    }
    // The unit alternatives all start with a distinct letter, so the first
    // character is enough to pick the multiplier.
    const unitChar = every[2].charAt(0)
    const unitMs = unitChar === 'm' ? MINUTE_MS : unitChar === 'h' ? HOUR_MS : DAY_MS
    const everyMs = Math.round(count * unitMs)
    if (everyMs < MIN_INTERVAL_MS) {
      return `Interval "${spec.trim()}" is too short: the minimum is 5 minutes.`
    }
    if (everyMs > MAX_INTERVAL_MS) {
      return `Interval "${spec.trim()}" is too long: the maximum is 365 days.`
    }
    return { kind: 'interval', everyMs }
  }

  const daily = /^daily at (\d{1,2}):(\d{2})$/.exec(s)
  if (daily) {
    const time = parseTime(daily[1], daily[2])
    if (typeof time === 'string') return time
    return { kind: 'daily', hour: time.hour, minute: time.minute }
  }

  const weekdays = /^weekdays at (\d{1,2}):(\d{2})$/.exec(s)
  if (weekdays) {
    const time = parseTime(weekdays[1], weekdays[2])
    if (typeof time === 'string') return time
    return { kind: 'weekdays', hour: time.hour, minute: time.minute }
  }

  const weekly = /^weekly on ([a-z]+) at (\d{1,2}):(\d{2})$/.exec(s)
  if (weekly) {
    const day = parseWeekday(weekly[1])
    if (day === null) {
      return `Unknown weekday "${weekly[1]}": use a full name (monday through sunday) or a 3-letter abbreviation (mon, tue, wed, thu, fri, sat, sun).`
    }
    const time = parseTime(weekly[2], weekly[3])
    if (typeof time === 'string') return time
    return { kind: 'weekly', day, hour: time.hour, minute: time.minute }
  }

  // The input was lowercased, so an ISO "T" separator arrives here as "t".
  const once = /^once at (\d{4})-(\d{2})-(\d{2})(?:t| )(\d{1,2}):(\d{2})$/.exec(s)
  if (once) {
    const time = parseTime(once[4], once[5])
    if (typeof time === 'string') return time
    const year = Number(once[1])
    const month = Number(once[2])
    const dayOfMonth = Number(once[3])
    const at = new Date(year, month - 1, dayOfMonth, time.hour, time.minute)
    // JS Date silently rolls invalid dates forward (Feb 30 -> Mar 2); a failed
    // component round-trip is how we detect that and refuse instead.
    if (
      at.getFullYear() !== year ||
      at.getMonth() !== month - 1 ||
      at.getDate() !== dayOfMonth
    ) {
      return `"${once[1]}-${once[2]}-${once[3]}" is not a real calendar date.`
    }
    if (now && at.getTime() <= now.getTime()) {
      return `The "once" time ${once[1]}-${once[2]}-${once[3]} ${pad2(time.hour)}:${pad2(time.minute)} is in the past; pick a future time.`
    }
    return { kind: 'once', at: at.getTime() }
  }

  return `Unrecognized schedule "${spec.trim()}". Supported forms:\n  ${SUPPORTED_FORMS}`
}

/**
 * First instant strictly after `after` that lands at HH:MM local time on a day
 * satisfying `matchesDay`. Candidates are built from local date components so
 * "the same wall-clock time tomorrow" stays correct across a DST change (a
 * fixed +24h in milliseconds would drift by an hour).
 *
 * The 0..7 offset window is sufficient for every predicate used here: 'daily'
 * matches any day, 'weekdays' is at most 3 days out (Friday evening to Monday),
 * and 'weekly' recurs within exactly 7 days. Offset 7 at any time of day is
 * always strictly after `after`, so the loop cannot fall through.
 */
function nextDayMatching(
  after: Date,
  hour: number,
  minute: number,
  matchesDay: (day: number) => boolean
): number {
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(
      after.getFullYear(),
      after.getMonth(),
      after.getDate() + offset,
      hour,
      minute
    )
    if (candidate.getTime() > after.getTime() && matchesDay(candidate.getDay())) {
      return candidate.getTime()
    }
  }
  // Unreachable per the window argument above; throwing (rather than returning
  // a wrong time) makes a future logic regression loud.
  throw new Error('nextDayMatching: no matching day within a week')
}

/**
 * The next fire time strictly AFTER `after`, as epoch ms; null when the spec
 * has no future occurrence (a 'once' whose time has passed). "Strictly after"
 * is what lets the scheduler pass its last fire time back in without running
 * the same occurrence twice.
 */
export function nextOccurrence(spec: ScheduleSpec, after: Date): number | null {
  switch (spec.kind) {
    case 'interval':
      return after.getTime() + spec.everyMs
    case 'daily':
      return nextDayMatching(after, spec.hour, spec.minute, () => true)
    case 'weekdays':
      return nextDayMatching(after, spec.hour, spec.minute, (day) => day >= 1 && day <= 5)
    case 'weekly':
      return nextDayMatching(after, spec.hour, spec.minute, (day) => day === spec.day)
    case 'once':
      return spec.at > after.getTime() ? spec.at : null
  }
}

/**
 * Render an interval in the largest unit that divides it evenly, so a spec
 * round-trips to something a user would have typed ("every 2h", not
 * "every 120m"). Falls back to (possibly fractional) minutes for mixed
 * intervals like "every 1.5h" -> "every 90m".
 */
function formatInterval(everyMs: number): string {
  if (everyMs % DAY_MS === 0) return `${everyMs / DAY_MS}d`
  if (everyMs % HOUR_MS === 0) return `${everyMs / HOUR_MS}h`
  return `${everyMs / MINUTE_MS}m`
}

/**
 * Short human description for lists and confirmations, e.g. "every 15m",
 * "daily at 09:30", "weekly on Monday at 09:30", "once at 2026-07-16 09:30".
 * 'once' is rendered in local time to match how it was entered.
 */
export function describeSpec(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'interval':
      return `every ${formatInterval(spec.everyMs)}`
    case 'daily':
      return `daily at ${pad2(spec.hour)}:${pad2(spec.minute)}`
    case 'weekdays':
      return `weekdays at ${pad2(spec.hour)}:${pad2(spec.minute)}`
    case 'weekly':
      return `weekly on ${DAY_NAMES[spec.day] ?? `day ${spec.day}`} at ${pad2(spec.hour)}:${pad2(spec.minute)}`
    case 'once': {
      const d = new Date(spec.at)
      return `once at ${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
  }
}
