import { describe, expect, it } from 'vitest'
import { addRound, fullTime, parseAt, relativeTime, turnStatsParts } from './messageMeta'

describe('relativeTime', () => {
  const now = new Date(2026, 10, 13, 15, 0, 0).getTime()
  const ago = (ms: number): string => relativeTime(now - ms, now)
  it('reads seconds as just now, then minutes and hours', () => {
    expect(ago(10_000)).toBe('just now')
    expect(ago(5 * 60_000)).toBe('5m ago')
    expect(ago(3 * 3_600_000)).toBe('3h ago')
  })
  it('names yesterday, then a weekday, then a date', () => {
    expect(relativeTime(new Date(2026, 10, 12, 9, 0).getTime(), now)).toBe('yesterday')
    const weekday = relativeTime(new Date(2026, 10, 9, 9, 0).getTime(), now)
    expect(weekday).toBe(new Date(2026, 10, 9).toLocaleDateString(undefined, { weekday: 'long' }))
    const older = relativeTime(new Date(2026, 9, 1, 9, 0).getTime(), now)
    expect(older).toBe(new Date(2026, 9, 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
  })
  it('adds the year for a date in another year', () => {
    const t = new Date(2025, 0, 2).getTime()
    expect(relativeTime(t, now)).toContain('2025')
  })
  it('treats a clock that went backwards as just now', () => {
    expect(relativeTime(now + 60_000, now)).toBe('just now')
  })
})

describe('parseAt', () => {
  it('parses ISO timestamps and refuses junk', () => {
    expect(parseAt('2026-11-13T10:00:00.000Z')).toBe(Date.UTC(2026, 10, 13, 10))
    expect(parseAt(undefined)).toBeUndefined()
    expect(parseAt('')).toBeUndefined()
    expect(parseAt('not a date')).toBeUndefined()
  })
  it('formats a full time for the hover', () => {
    expect(fullTime(Date.UTC(2026, 10, 13, 10))).toContain('2026')
  })
})

describe('addRound and turnStatsParts', () => {
  it('sums rounds and lists each model once, in order', () => {
    let s = addRound(undefined, 'model-a', { inputTokens: 1000, outputTokens: 200, cost: 0.01 })
    s = addRound(s, 'model-b', { inputTokens: 1500, outputTokens: 100, cost: 0.02 })
    s = addRound(s, 'model-a', { inputTokens: 500, outputTokens: 50, cost: 0 })
    expect(s).toEqual({ models: ['model-a', 'model-b'], inputTokens: 3000, outputTokens: 350, cost: 0.03 })
    expect(turnStatsParts(s)).toEqual(['model-a, model-b', '3k in, 350 out', '$0.030'])
  })
  it('leaves out a cost that is not known and ignores junk numbers', () => {
    const s = addRound(undefined, 'local', { inputTokens: Number.NaN, outputTokens: -5, cost: 0 })
    expect(turnStatsParts(s)).toEqual(['local'])
  })
  it('does not change the tally it was given', () => {
    const s = addRound(undefined, 'm', { inputTokens: 1, outputTokens: 1, cost: 0 })
    addRound(s, 'n', { inputTokens: 1, outputTokens: 1, cost: 0 })
    expect(s.models).toEqual(['m'])
  })
})
