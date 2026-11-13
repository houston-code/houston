import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Durability of the atomic writes: the temp is flushed before it is renamed into place
 * (so a power loss can't surface an empty file under the real name), and on Windows a
 * rename refused while another process holds the target is retried. fs is wrapped so
 * the order of calls is observable and renames can be made to fail on cue.
 */

const fsState = vi.hoisted(() => ({
  calls: [] as string[],
  /** Errors the next renames throw, in order, before renames go through again. */
  renameFailures: [] as string[]
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const busy = (code: string): Error => Object.assign(new Error(`${code}: operation not permitted`), { code })
  const fsyncSync: typeof actual.fsyncSync = (fd) => {
    fsState.calls.push('fsync')
    actual.fsyncSync(fd)
  }
  const renameSync: typeof actual.renameSync = (from, to) => {
    fsState.calls.push('rename')
    const code = fsState.renameFailures.shift()
    if (code) throw busy(code)
    actual.renameSync(from, to)
  }
  const promises = {
    ...actual.promises,
    open: async (...args: Parameters<typeof actual.promises.open>) => {
      const handle = await actual.promises.open(...args)
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        fsState.calls.push('fsync')
        await sync()
      }
      return handle
    },
    rename: async (from: string, to: string) => {
      fsState.calls.push('rename')
      const code = fsState.renameFailures.shift()
      if (code) throw busy(code)
      await actual.promises.rename(from, to)
    }
  }
  const mocked = { ...actual, fsyncSync, renameSync, promises }
  return { ...mocked, default: mocked }
})

import { preserveCorruptFile, writeFileAtomic, writeFileAtomicStampedSync, writeFileAtomicSync } from './atomic-write'

const realPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-atomic-durable-'))
  fsState.calls = []
  fsState.renameFailures = []
})
afterEach(() => {
  setPlatform(realPlatform)
  rmSync(dir, { recursive: true, force: true })
})

describe('flush before rename', () => {
  it.each([
    ['writeFileAtomicSync', (p: string) => writeFileAtomicSync(p, 'data')],
    ['writeFileAtomicStampedSync', (p: string) => void writeFileAtomicStampedSync(p, 'data')],
    ['writeFileAtomic', (p: string) => writeFileAtomic(p, 'data')]
  ])('%s fsyncs the temp before renaming it into place', async (_name, write) => {
    const path = join(dir, 'f.json')
    await write(path)
    expect(readFileSync(path, 'utf8')).toBe('data')
    expect(fsState.calls).toEqual(['fsync', 'rename'])
  })

  it('skips the fsync for a hot-path caller that opts out', () => {
    const path = join(dir, 'chat.json')
    writeFileAtomicStampedSync(path, 'data', 0o600, { durable: false })
    expect(readFileSync(path, 'utf8')).toBe('data')
    expect(fsState.calls).toEqual(['rename'])
  })
})

describe('Windows rename retry', () => {
  it('retries a rename Windows refuses while the target is held open', async () => {
    setPlatform('win32')
    const path = join(dir, 'f.json')
    fsState.renameFailures = ['EPERM', 'EBUSY']
    writeFileAtomicSync(path, 'sync')
    expect(readFileSync(path, 'utf8')).toBe('sync')
    fsState.renameFailures = ['EACCES', 'EPERM']
    await writeFileAtomic(path, 'async')
    expect(readFileSync(path, 'utf8')).toBe('async')
    expect(fsState.calls.filter((c) => c === 'rename')).toHaveLength(6)
    expect(readdirSync(dir)).toEqual(['f.json'])
  })

  it('gives up after a few hundred ms and cleans up the temp', () => {
    setPlatform('win32')
    fsState.renameFailures = Array(10).fill('EBUSY')
    const started = Date.now()
    expect(() => writeFileAtomicSync(join(dir, 'f.json'), 'x')).toThrow(/EBUSY/)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not retry elsewhere, where EPERM is a real permission error', () => {
    setPlatform('linux')
    fsState.renameFailures = ['EPERM']
    expect(() => writeFileAtomicSync(join(dir, 'f.json'), 'x')).toThrow(/EPERM/)
    expect(fsState.calls.filter((c) => c === 'rename')).toHaveLength(1)
  })
})

describe('preserveCorruptFile', () => {
  it('copies the bytes to a 0600 .corrupt-<timestamp> file and leaves the original', () => {
    const path = join(dir, 'settings.json')
    writeFileSync(path, '{"a":1,}', { mode: 0o644 })
    const kept = preserveCorruptFile(path, new Date('2026-11-14T10:20:30.456Z'))
    expect(kept).toBe(`${path}.corrupt-2026-11-14T10-20-30-456Z`)
    expect(readFileSync(kept!, 'utf8')).toBe('{"a":1,}')
    expect(readFileSync(path, 'utf8')).toBe('{"a":1,}')
    if (realPlatform !== 'win32') expect(statSync(kept!).mode & 0o777).toBe(0o600)
  })

  it('never overwrites an earlier copy, and reports a missing file as null', () => {
    const path = join(dir, 'settings.json')
    const at = new Date('2026-11-14T10:20:30.456Z')
    writeFileSync(path, 'first')
    preserveCorruptFile(path, at)
    writeFileSync(path, 'second')
    expect(preserveCorruptFile(path, at)).toBeNull()
    expect(readFileSync(`${path}.corrupt-2026-11-14T10-20-30-456Z`, 'utf8')).toBe('first')
    expect(preserveCorruptFile(join(dir, 'missing.json'))).toBeNull()
  })
})
