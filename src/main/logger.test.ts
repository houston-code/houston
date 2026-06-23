import { describe, it, expect } from 'vitest'
import { formatLogLine, needsRotation } from './logger'

describe('formatLogLine', () => {
  it('formats an ISO-timestamped, levelled line', () => {
    const t = new Date('2026-01-02T03:04:05.000Z')
    expect(formatLogLine('INFO', 'started', t)).toBe('2026-01-02T03:04:05.000Z [INFO] started')
  })

  it('collapses newlines so each entry stays one line', () => {
    const t = new Date('2026-01-02T03:04:05.000Z')
    expect(formatLogLine('ERROR', 'boom\n  at foo', t)).toBe(
      '2026-01-02T03:04:05.000Z [ERROR] boom ⏎ at foo'
    )
  })
})

describe('needsRotation', () => {
  it('rotates only past the cap', () => {
    expect(needsRotation(10, 100)).toBe(false)
    expect(needsRotation(100, 100)).toBe(false)
    expect(needsRotation(101, 100)).toBe(true)
  })
})
