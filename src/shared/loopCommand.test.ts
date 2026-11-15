import { describe, expect, it } from 'vitest'
import {
  LOOP_DEFAULT_SPEC,
  LOOP_USAGE,
  loopScheduleName,
  numberedSchedules,
  parseLoopArgs,
  parseScheduleArgs,
  scheduleListLines,
  scheduleWhen
} from './loopCommand'
import { MAX_SCHEDULE_PROMPT } from './schedules'

describe('parseLoopArgs', () => {
  it('reads a short interval as "every <interval>"', () => {
    expect(parseLoopArgs('10m check CI')).toEqual({ ok: true, spec: 'every 10m', task: 'check CI' })
    expect(parseLoopArgs('2h  run the tests')).toEqual({ ok: true, spec: 'every 2h', task: 'run the tests' })
    expect(parseLoopArgs('1.5 hours tidy up')).toEqual({ ok: true, spec: 'every 1.5 hours', task: 'tidy up' })
  })

  it('reads the scheduler\'s own forms at the start', () => {
    expect(parseLoopArgs('every 30 minutes look at the queue')).toEqual({ ok: true, spec: 'every 30 minutes', task: 'look at the queue' })
    expect(parseLoopArgs('daily at 09:00 summarize new issues')).toEqual({ ok: true, spec: 'daily at 09:00', task: 'summarize new issues' })
    expect(parseLoopArgs('weekdays at 9:30 standup notes')).toEqual({ ok: true, spec: 'weekdays at 9:30', task: 'standup notes' })
    expect(parseLoopArgs('weekly on monday at 08:00 plan the week')).toEqual({
      ok: true,
      spec: 'weekly on monday at 08:00',
      task: 'plan the week'
    })
  })

  it('runs every 10 minutes without an interval, and keeps a number that is not one', () => {
    expect(parseLoopArgs('check CI')).toEqual({ ok: true, spec: LOOP_DEFAULT_SPEC, task: 'check CI' })
    expect(parseLoopArgs('3 things to check')).toEqual({ ok: true, spec: LOOP_DEFAULT_SPEC, task: '3 things to check' })
  })

  it('needs a prompt, and one that fits', () => {
    expect(parseLoopArgs('')).toEqual({ ok: false, error: LOOP_USAGE })
    expect(parseLoopArgs('10m')).toEqual({ ok: false, error: LOOP_USAGE })
    expect(parseLoopArgs('every 2 hours')).toEqual({ ok: false, error: LOOP_USAGE })
    expect(parseLoopArgs(`10m ${'x'.repeat(MAX_SCHEDULE_PROMPT + 1)}`)).toMatchObject({ ok: false })
  })
})

describe('parseScheduleArgs', () => {
  it('lists, cancels by number, or explains', () => {
    expect(parseScheduleArgs('')).toEqual({ op: 'list' })
    expect(parseScheduleArgs('list')).toEqual({ op: 'list' })
    expect(parseScheduleArgs('cancel 2')).toEqual({ op: 'cancel', index: 2 })
    expect(parseScheduleArgs('cancel #3')).toEqual({ op: 'cancel', index: 3 })
    expect(parseScheduleArgs('cancel 0')).toEqual({ op: 'usage' })
    expect(parseScheduleArgs('cancel')).toEqual({ op: 'usage' })
    expect(parseScheduleArgs('nonsense')).toEqual({ op: 'usage' })
  })
})

describe('schedule listings', () => {
  const now = new Date(2026, 10, 15, 9, 0).getTime()
  const base = { workspace: '/w', paused: false, lastResult: undefined }
  const list = [
    { ...base, id: 'b', name: 'second', spec: 'daily at 10:00', createdAt: 2, nextRunAt: new Date(2026, 10, 16, 10, 0).getTime() },
    { ...base, id: 'a', name: 'first', spec: 'every 10m', createdAt: 1, nextRunAt: new Date(2026, 10, 15, 9, 10).getTime(), lastResult: 'ok' as const },
    { ...base, id: 'c', name: 'third', spec: 'every 1h', createdAt: 3, nextRunAt: null, paused: true }
  ]

  it('numbers oldest first, so a number stays put as schedules are added', () => {
    expect(numberedSchedules(list).map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })

  it('says when each runs next and how the last run went', () => {
    expect(scheduleListLines(list, now, (w) => `~${w}`)).toEqual([
      '1. first: every 10m, next at 09:10, last run finished (~/w)',
      '2. second: daily at 10:00, next at 2026-11-16 10:00 (~/w)',
      '3. third: every 1h, paused (~/w)'
    ])
  })

  it('names a schedule from the first line of its prompt', () => {
    expect(loopScheduleName('check CI\nthen report')).toBe('check CI')
    expect(loopScheduleName('x'.repeat(200))).toHaveLength(80)
    expect(scheduleWhen(new Date(2026, 10, 15, 23, 5).getTime(), now)).toBe('23:05')
  })
})
