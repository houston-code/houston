import { describe, expect, it } from 'vitest'
import {
  LOOP_DEFAULT_SPEC,
  LOOP_USAGE,
  loopScheduleName,
  parseLoopArgs,
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

describe('loop schedule names', () => {
  const now = new Date(2026, 10, 15, 9, 0).getTime()

  it('names a schedule from the first line of its prompt', () => {
    expect(loopScheduleName('check CI\nthen report')).toBe('check CI')
    expect(loopScheduleName('x'.repeat(200))).toHaveLength(80)
    expect(scheduleWhen(new Date(2026, 10, 15, 23, 5).getTime(), now)).toBe('23:05')
  })
})
