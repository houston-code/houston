import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

import { configureLogRedactor, FLUSH_MS, flushLogSync, formatLogLine, log, minLogLevel, needsRotation, shouldLog } from './logger'

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

describe('log levels', () => {
  it('reads HOUSTON_LOG_LEVEL, defaulting to info', () => {
    expect(minLogLevel({})).toBe('INFO')
    expect(minLogLevel({ HOUSTON_LOG_LEVEL: 'debug' })).toBe('DEBUG')
    expect(minLogLevel({ HOUSTON_LOG_LEVEL: ' Warn ' })).toBe('WARN')
    expect(minLogLevel({ HOUSTON_LOG_LEVEL: 'warning' })).toBe('WARN')
    expect(minLogLevel({ HOUSTON_LOG_LEVEL: 'error' })).toBe('ERROR')
    expect(minLogLevel({ HOUSTON_LOG_LEVEL: 'loud' })).toBe('INFO')
  })

  it('writes a level at or above the minimum', () => {
    expect(shouldLog('DEBUG', 'INFO')).toBe(false)
    expect(shouldLog('INFO', 'INFO')).toBe(true)
    expect(shouldLog('WARN', 'ERROR')).toBe(false)
    expect(shouldLog('ERROR', 'WARN')).toBe(true)
  })
})

describe('buffered writes', () => {
  const saved = process.env.HOUSTON_LOG_LEVEL
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'houston-logger-'))
  })
  afterEach(() => {
    flushLogSync()
    configureLogRedactor((m) => m)
    if (saved === undefined) delete process.env.HOUSTON_LOG_LEVEL
    else process.env.HOUSTON_LOG_LEVEL = saved
    rmSync(state.userData, { recursive: true, force: true })
  })
  const path = (): string => join(state.userData, 'logs', 'houston.log')
  const contents = (): string => (existsSync(path()) ? readFileSync(path(), 'utf8') : '')

  it('holds info lines briefly, then appends them in order', async () => {
    log.info('one')
    log.warn('two')
    expect(contents()).toBe('')
    await new Promise((r) => setTimeout(r, FLUSH_MS * 3))
    const lines = contents().trim().split('\n')
    expect(lines.map((l) => l.replace(/^\S+ /, ''))).toEqual(['[INFO] one', '[WARN] two'])
  })

  it('writes an error, and everything before it, at once', () => {
    log.info('before')
    log.error('boom')
    expect(contents()).toMatch(/\[INFO\] before\n.*\[ERROR\] boom\n$/)
  })

  it('never lets an error overtake a batch the timer already took', async () => {
    log.info('first: the context')
    // A timer set after the logger's runs right after its flush: the moment an error
    // that follows the batch is logged.
    const after = await new Promise<string>((resolve) =>
      setTimeout(() => {
        log.error('second: the failure')
        resolve(contents())
      }, FLUSH_MS)
    )
    const lines = (s: string): string[] => s.trim().split('\n').map((l) => l.replace(/^\S+ /, ''))
    expect(lines(after)).toEqual(['[INFO] first: the context', '[ERROR] second: the failure'])
    await new Promise((r) => setTimeout(r, FLUSH_MS * 2))
    expect(lines(contents())).toEqual(['[INFO] first: the context', '[ERROR] second: the failure'])
  })

  it('drops debug lines unless HOUSTON_LOG_LEVEL=debug, and redacts them when written', () => {
    delete process.env.HOUSTON_LOG_LEVEL
    log.debug('hidden')
    process.env.HOUSTON_LOG_LEVEL = 'debug'
    configureLogRedactor((m) => m.replaceAll('tok-123', '[redacted]'))
    log.debug('shown tok-123')
    flushLogSync()
    expect(contents()).not.toContain('hidden')
    expect(contents()).toContain('[DEBUG] shown [redacted]')
    expect(contents()).not.toContain('tok-123')
  })

  it('drops info and warn lines at HOUSTON_LOG_LEVEL=error', () => {
    process.env.HOUSTON_LOG_LEVEL = 'error'
    log.info('quiet')
    log.warn('quieter')
    log.error('loud')
    expect(contents()).not.toMatch(/quiet/)
    expect(contents()).toContain('[ERROR] loud')
  })

  it('keeps each line in the file of the profile it was logged under', () => {
    log.info('first profile')
    const first = path()
    state.userData = mkdtempSync(join(tmpdir(), 'houston-logger-'))
    log.info('second profile')
    flushLogSync()
    expect(readFileSync(first, 'utf8')).toContain('first profile')
    expect(readFileSync(first, 'utf8')).not.toContain('second profile')
    expect(contents()).toContain('second profile')
  })
})

describe.skipIf(process.platform === 'win32')('log file permissions', () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), 'houston-logger-perm-'))
  })
  afterEach(() => {
    flushLogSync()
    rmSync(state.userData, { recursive: true, force: true })
  })

  const mode = (p: string): number => statSync(p).mode & 0o777

  it('creates the log folder 0700 and the log 0600, so other local accounts cannot read it', () => {
    log.info('first line')
    flushLogSync()
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
    flushLogSync()
    expect(mode(dir)).toBe(0o700)
    expect(mode(join(dir, 'houston.log'))).toBe(0o600)
    expect(mode(join(dir, 'houston.log.1'))).toBe(0o600)
    expect(readFileSync(join(dir, 'houston.log'), 'utf8')).toContain('next line')
  })
})
