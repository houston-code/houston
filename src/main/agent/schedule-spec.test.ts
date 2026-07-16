import { describe, expect, it } from 'vitest'
import {
  describeSpec,
  MIN_INTERVAL_MS,
  nextOccurrence,
  parseScheduleSpec,
  type ScheduleSpec
} from './schedule-spec'

// All dates below are built from explicit local components so the tests are
// timezone-independent. Anchor week: 2026-07-13 is a Monday, 2026-07-15 a
// Wednesday, 2026-07-17 a Friday, 2026-07-18/19 the weekend, 2026-07-20 the
// next Monday.

/** Parse a spec that must succeed; fails the test with the error otherwise. */
function parsed(spec: string, now?: Date): ScheduleSpec {
  const result = parseScheduleSpec(spec, now)
  if (typeof result === 'string') throw new Error(`expected "${spec}" to parse, got: ${result}`)
  return result
}

/** Parse a spec that must fail; returns the error string for content checks. */
function failed(spec: string, now?: Date): string {
  const result = parseScheduleSpec(spec, now)
  if (typeof result !== 'string') {
    throw new Error(`expected "${spec}" to be rejected, got ${JSON.stringify(result)}`)
  }
  return result
}

describe('parseScheduleSpec: interval form', () => {
  it('parses every accepted minute/hour/day unit spelling', () => {
    const cases: Array<[string, number]> = [
      ['every 15m', 15 * 60_000],
      ['every 15 min', 15 * 60_000],
      ['every 30mins', 30 * 60_000],
      ['every 45 minute', 45 * 60_000],
      ['every 90 minutes', 90 * 60_000],
      ['every 1h', 3_600_000],
      ['every 2 hr', 2 * 3_600_000],
      ['every 3hrs', 3 * 3_600_000],
      ['every 4 hour', 4 * 3_600_000],
      ['every 5 hours', 5 * 3_600_000],
      ['every 1d', 86_400_000],
      ['every 2 day', 2 * 86_400_000],
      ['every 7 days', 7 * 86_400_000]
    ]
    for (const [spec, everyMs] of cases) {
      expect(parsed(spec)).toEqual({ kind: 'interval', everyMs })
    }
  })

  it('is case-insensitive and forgiving about whitespace', () => {
    expect(parsed('  EVERY   15  Minutes ')).toEqual({ kind: 'interval', everyMs: 900_000 })
  })

  it('accepts fractional counts (every 1.5h is 90 minutes)', () => {
    expect(parsed('every 1.5h')).toEqual({ kind: 'interval', everyMs: 90 * 60_000 })
  })

  it('rejects intervals below the 5-minute floor, naming the minimum', () => {
    expect(failed('every 4m')).toContain('minimum is 5 minutes')
    expect(failed('every 1 minute')).toContain('minimum is 5 minutes')
    // Sub-minute expressed in hours still hits the same floor.
    expect(failed('every 0.01h')).toContain('minimum is 5 minutes')
  })

  it('accepts exactly the minimum interval', () => {
    expect(parsed('every 5m')).toEqual({ kind: 'interval', everyMs: MIN_INTERVAL_MS })
  })

  it('rejects a zero count', () => {
    expect(failed('every 0m')).toContain('positive number')
  })

  it('rejects a malformed count that parses to NaN', () => {
    expect(failed('every 1.2.3m')).toContain('positive number')
  })

  it('rejects a negative count (falls through to the unrecognized-form error)', () => {
    expect(typeof parseScheduleSpec('every -5m')).toBe('string')
  })

  it('caps intervals at 365 days', () => {
    expect(failed('every 366d')).toContain('365 days')
    expect(parsed('every 365 days')).toEqual({ kind: 'interval', everyMs: 365 * 86_400_000 })
  })
})

describe('parseScheduleSpec: daily and weekdays forms', () => {
  it('parses daily at HH:MM and H:MM', () => {
    expect(parsed('daily at 09:30')).toEqual({ kind: 'daily', hour: 9, minute: 30 })
    expect(parsed('daily at 9:30')).toEqual({ kind: 'daily', hour: 9, minute: 30 })
    expect(parsed('Daily At 23:59')).toEqual({ kind: 'daily', hour: 23, minute: 59 })
    expect(parsed('daily at 0:00')).toEqual({ kind: 'daily', hour: 0, minute: 0 })
  })

  it('parses weekdays at HH:MM', () => {
    expect(parsed('weekdays at 08:15')).toEqual({ kind: 'weekdays', hour: 8, minute: 15 })
  })

  it('rejects out-of-range hours and minutes with the valid range', () => {
    expect(failed('daily at 24:00')).toContain('0-23')
    expect(failed('daily at 12:60')).toContain('0-59')
    expect(failed('weekdays at 25:15')).toContain('0-23')
  })
})

describe('parseScheduleSpec: weekly form', () => {
  it('parses full weekday names into getDay() indices', () => {
    expect(parsed('weekly on sunday at 0:00')).toEqual({
      kind: 'weekly',
      day: 0,
      hour: 0,
      minute: 0
    })
    expect(parsed('weekly on monday at 09:30')).toEqual({
      kind: 'weekly',
      day: 1,
      hour: 9,
      minute: 30
    })
    expect(parsed('weekly on saturday at 13:05')).toEqual({
      kind: 'weekly',
      day: 6,
      hour: 13,
      minute: 5
    })
  })

  it('parses 3-letter abbreviations, case-insensitively', () => {
    expect(parsed('weekly on Mon at 9:30')).toEqual({ kind: 'weekly', day: 1, hour: 9, minute: 30 })
    expect(parsed('weekly on FRI at 17:00')).toEqual({
      kind: 'weekly',
      day: 5,
      hour: 17,
      minute: 0
    })
  })

  it('rejects an unknown weekday, listing the valid names', () => {
    const err = failed('weekly on funday at 09:30')
    expect(err).toContain('funday')
    expect(err).toContain('mon')
    expect(err).toContain('sunday')
  })

  it('validates the time like the other calendar forms', () => {
    expect(failed('weekly on monday at 09:61')).toContain('0-59')
  })
})

describe('parseScheduleSpec: once form', () => {
  it('parses "YYYY-MM-DD HH:MM" as local time', () => {
    const spec = parsed('once at 2026-07-16 09:30')
    expect(spec).toEqual({ kind: 'once', at: new Date(2026, 6, 16, 9, 30).getTime() })
  })

  it('accepts the ISO "T" separator', () => {
    const spec = parsed('once at 2026-07-16T09:30')
    expect(spec).toEqual({ kind: 'once', at: new Date(2026, 6, 16, 9, 30).getTime() })
  })

  it('rejects a time in the past when now is provided', () => {
    const now = new Date(2026, 6, 17, 12, 0)
    expect(failed('once at 2026-07-16 09:30', now)).toContain('in the past')
  })

  it('treats a time equal to now as past (it could never fire strictly after)', () => {
    const now = new Date(2026, 6, 16, 9, 30)
    expect(failed('once at 2026-07-16 09:30', now)).toContain('in the past')
  })

  it('skips the past check when now is omitted (re-parsing a stored spec)', () => {
    expect(parsed('once at 2001-01-01 00:00')).toEqual({
      kind: 'once',
      at: new Date(2001, 0, 1, 0, 0).getTime()
    })
  })

  it('rejects impossible calendar dates instead of letting Date roll them over', () => {
    expect(failed('once at 2026-02-30 09:30')).toContain('not a real calendar date')
    expect(failed('once at 2026-13-01 09:30')).toContain('not a real calendar date')
  })

  it('validates the time of day', () => {
    expect(failed('once at 2026-07-16 24:00')).toContain('0-23')
  })
})

describe('parseScheduleSpec: unrecognized input', () => {
  it('lists every supported form in the error', () => {
    const err = failed('yearly on jan 1')
    expect(err).toContain('every <N><unit>')
    expect(err).toContain('daily at HH:MM')
    expect(err).toContain('weekdays at HH:MM')
    expect(err).toContain('weekly on <day> at HH:MM')
    expect(err).toContain('once at YYYY-MM-DD HH:MM')
  })

  it('rejects the unsupported hourly form', () => {
    expect(typeof parseScheduleSpec('hourly at :30')).toBe('string')
  })

  it('rejects empty and whitespace-only input', () => {
    expect(typeof parseScheduleSpec('')).toBe('string')
    expect(typeof parseScheduleSpec('   ')).toBe('string')
  })
})

describe('nextOccurrence: interval', () => {
  it('fires a fixed offset after the given instant', () => {
    const after = new Date(2026, 6, 15, 9, 30)
    const spec: ScheduleSpec = { kind: 'interval', everyMs: 15 * 60_000 }
    expect(nextOccurrence(spec, after)).toBe(after.getTime() + 15 * 60_000)
  })
})

describe('nextOccurrence: daily', () => {
  const spec: ScheduleSpec = { kind: 'daily', hour: 9, minute: 30 }

  it('fires later today when the time has not passed yet', () => {
    const after = new Date(2026, 6, 15, 8, 0)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 15, 9, 30).getTime())
  })

  it('rolls to tomorrow when after is exactly the occurrence (strictly after)', () => {
    const after = new Date(2026, 6, 15, 9, 30)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 16, 9, 30).getTime())
  })

  it('rolls to tomorrow when the time already passed', () => {
    const after = new Date(2026, 6, 15, 10, 0)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 16, 9, 30).getTime())
  })

  it('crosses midnight into the next day (and the next month)', () => {
    const midnightish: ScheduleSpec = { kind: 'daily', hour: 0, minute: 5 }
    expect(nextOccurrence(midnightish, new Date(2026, 6, 15, 23, 50))).toBe(
      new Date(2026, 6, 16, 0, 5).getTime()
    )
    expect(nextOccurrence(midnightish, new Date(2026, 6, 31, 23, 50))).toBe(
      new Date(2026, 7, 1, 0, 5).getTime()
    )
  })
})

describe('nextOccurrence: weekdays', () => {
  const spec: ScheduleSpec = { kind: 'weekdays', hour: 9, minute: 30 }

  it('fires the same day when a weekday occurrence is still ahead', () => {
    // 2026-07-15 is a Wednesday.
    const after = new Date(2026, 6, 15, 8, 0)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 15, 9, 30).getTime())
  })

  it('excludes an occurrence exactly at after, rolling to the next weekday', () => {
    const after = new Date(2026, 6, 15, 9, 30)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 16, 9, 30).getTime())
  })

  it('wraps a Friday-evening after over the weekend to Monday', () => {
    // 2026-07-17 is a Friday; 2026-07-20 the next Monday.
    const after = new Date(2026, 6, 17, 10, 0)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 20, 9, 30).getTime())
  })

  it('skips Saturday and Sunday entirely', () => {
    const saturday = new Date(2026, 6, 18, 8, 0)
    expect(nextOccurrence(spec, saturday)).toBe(new Date(2026, 6, 20, 9, 30).getTime())
    const sunday = new Date(2026, 6, 19, 23, 0)
    expect(nextOccurrence(spec, sunday)).toBe(new Date(2026, 6, 20, 9, 30).getTime())
  })
})

describe('nextOccurrence: weekly', () => {
  const spec: ScheduleSpec = { kind: 'weekly', day: 1, hour: 9, minute: 30 } // Monday

  it('fires on the next occurrence of the target weekday', () => {
    // From Wednesday 2026-07-15, the next Monday is 2026-07-20.
    const after = new Date(2026, 6, 15, 12, 0)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 20, 9, 30).getTime())
  })

  it('fires later the same day when after is earlier that weekday', () => {
    const after = new Date(2026, 6, 20, 6, 0)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 20, 9, 30).getTime())
  })

  it('wraps a full week when after is exactly the occurrence', () => {
    const after = new Date(2026, 6, 20, 9, 30)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 27, 9, 30).getTime())
  })

  it('wraps a full week when the time that day has already passed', () => {
    const after = new Date(2026, 6, 20, 9, 31)
    expect(nextOccurrence(spec, after)).toBe(new Date(2026, 6, 27, 9, 30).getTime())
  })
})

describe('nextOccurrence: once', () => {
  it('fires at the stored time when it is still in the future', () => {
    const at = new Date(2026, 6, 16, 9, 30).getTime()
    const spec: ScheduleSpec = { kind: 'once', at }
    expect(nextOccurrence(spec, new Date(2026, 6, 15, 9, 30))).toBe(at)
  })

  it('returns null when the time equals after (strictly-after contract)', () => {
    const at = new Date(2026, 6, 16, 9, 30).getTime()
    const spec: ScheduleSpec = { kind: 'once', at }
    expect(nextOccurrence(spec, new Date(2026, 6, 16, 9, 30))).toBeNull()
  })

  it('returns null when the time has passed', () => {
    const at = new Date(2026, 6, 16, 9, 30).getTime()
    const spec: ScheduleSpec = { kind: 'once', at }
    expect(nextOccurrence(spec, new Date(2026, 6, 17, 0, 0))).toBeNull()
  })
})

describe('describeSpec', () => {
  it('renders intervals in the largest even unit', () => {
    expect(describeSpec({ kind: 'interval', everyMs: 15 * 60_000 })).toBe('every 15m')
    expect(describeSpec({ kind: 'interval', everyMs: 2 * 3_600_000 })).toBe('every 2h')
    expect(describeSpec({ kind: 'interval', everyMs: 86_400_000 })).toBe('every 1d')
    // 90 minutes is not a whole number of hours, so it stays in minutes.
    expect(describeSpec({ kind: 'interval', everyMs: 90 * 60_000 })).toBe('every 90m')
  })

  it('zero-pads calendar times', () => {
    expect(describeSpec({ kind: 'daily', hour: 9, minute: 5 })).toBe('daily at 09:05')
    expect(describeSpec({ kind: 'weekdays', hour: 8, minute: 15 })).toBe('weekdays at 08:15')
  })

  it('names the weekday for weekly specs', () => {
    expect(describeSpec({ kind: 'weekly', day: 1, hour: 9, minute: 30 })).toBe(
      'weekly on Monday at 09:30'
    )
    expect(describeSpec({ kind: 'weekly', day: 0, hour: 0, minute: 0 })).toBe(
      'weekly on Sunday at 00:00'
    )
  })

  it('renders once specs as local YYYY-MM-DD HH:MM', () => {
    const at = new Date(2026, 6, 16, 9, 30).getTime()
    expect(describeSpec({ kind: 'once', at })).toBe('once at 2026-07-16 09:30')
  })

  it('round-trips a parsed spec through describe and back', () => {
    for (const input of ['every 15m', 'daily at 09:30', 'weekdays at 08:15', 'weekly on monday at 09:30']) {
      const spec = parsed(input)
      expect(parseScheduleSpec(describeSpec(spec))).toEqual(spec)
    }
  })
})
