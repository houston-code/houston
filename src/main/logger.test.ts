import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

import { configureLogRedactor, formatLogLine, log, needsRotation } from './logger'

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

describe('log redactor seam', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'houston-logger-'))
  })
  afterEach(() => {
    configureLogRedactor((m) => m) // restore identity so other tests are unaffected
    rmSync(state.userData, { recursive: true, force: true })
  })

  const logContents = (): string => readFileSync(join(state.userData, 'logs', 'houston.log'), 'utf8')

  it('scrubs a configured secret from written lines', () => {
    configureLogRedactor((m) => m.replaceAll('super-secret-token', '[redacted:secret]'))
    log.error('provider call failed with key super-secret-token')
    const contents = logContents()
    expect(contents).not.toContain('super-secret-token')
    expect(contents).toContain('[redacted:secret]')
  })

  it('a throwing redactor never breaks logging', () => {
    configureLogRedactor(() => {
      throw new Error('redactor blew up')
    })
    expect(() => log.info('hello')).not.toThrow()
    // The faulty redactor swallows the whole write; the app keeps running.
  })
})
