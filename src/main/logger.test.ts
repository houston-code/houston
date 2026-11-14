import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

describe.skipIf(process.platform === 'win32')('log file permissions', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'houston-logger-perm-'))
  })
  afterEach(() => {
    rmSync(state.userData, { recursive: true, force: true })
  })

  const mode = (p: string): number => statSync(p).mode & 0o777

  it('creates the log folder 0700 and the log 0600, so other local accounts cannot read it', () => {
    log.info('first line')
    expect(mode(join(state.userData, 'logs'))).toBe(0o700)
    expect(mode(join(state.userData, 'logs', 'houston.log'))).toBe(0o600)
  })

  it('tightens a folder, log, and rotated log an earlier version left world-readable', () => {
    const dir = join(state.userData, 'logs')
    mkdirSync(dir)
    chmodSync(dir, 0o755)
    writeFileSync(join(dir, 'houston.log'), 'old\n')
    chmodSync(join(dir, 'houston.log'), 0o644)
    writeFileSync(join(dir, 'houston.log.1'), 'older\n')
    chmodSync(join(dir, 'houston.log.1'), 0o644)
    log.warn('next line')
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'houston.log'))).toBe(0o600)
    expect(mode(join(dir, 'houston.log.1'))).toBe(0o600)
    expect(readFileSync(join(dir, 'houston.log'), 'utf8')).toContain('next line')
  })
})
