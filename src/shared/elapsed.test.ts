import { describe, expect, it } from 'vitest'
import { formatElapsed } from './elapsed'

describe('formatElapsed', () => {
  it('counts whole seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(999)).toBe('0s')
    expect(formatElapsed(4_200)).toBe('4s')
    expect(formatElapsed(59_999)).toBe('59s')
  })

  it('switches to minutes and seconds, then hours and minutes', () => {
    expect(formatElapsed(60_000)).toBe('1m 0s')
    expect(formatElapsed(192_000)).toBe('3m 12s')
    expect(formatElapsed(3_600_000)).toBe('1h 0m')
    expect(formatElapsed(3_840_000)).toBe('1h 4m')
  })

  it('reads a negative or non-finite span as zero', () => {
    expect(formatElapsed(-5)).toBe('0s')
    expect(formatElapsed(Number.NaN)).toBe('0s')
  })
})
