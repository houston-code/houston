import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from './fileLock'

let dir: string
let target: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'houston-lock-'))
  target = join(dir, 'AGENTS.md')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/**
 * Another process that holds `<target>.lock` for `holdMs`, optionally appending a
 * line to the target while it holds it (another app's save landing mid-wait).
 * Resolves once the lock file exists.
 */
function holdLockInChild(holdMs: number, appendLine?: string): Promise<void> {
  const script = `
    const fs = require('fs')
    const [lock, target, hold, line] = process.argv.slice(1)
    fs.writeFileSync(lock, 'child', { flag: 'wx' })
    process.stdout.write('held\\n')
    setTimeout(() => {
      if (line) fs.appendFileSync(target, line + '\\n')
      fs.unlinkSync(lock)
    }, Number(hold))
  `
  const child = spawn(process.execPath, ['-e', script, `${target}.lock`, target, String(holdMs), appendLine ?? ''])
  return new Promise((res, rej) => {
    child.stdout.once('data', () => res())
    child.once('error', rej)
  })
}

describe('withFileLock', () => {
  it('runs the callback, returns its value, and removes the lock', async () => {
    expect(await withFileLock(target, () => 42)).toBe(42)
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('releases the lock when the callback throws', async () => {
    await expect(
      withFileLock(target, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('waits for a lock held by another process, then runs', async () => {
    await holdLockInChild(300)
    const start = Date.now()
    const ran = await withFileLock(target, () => Date.now())
    expect(ran - start).toBeGreaterThanOrEqual(150)
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it("reads the other process's write once it gets the lock", async () => {
    writeFileSync(target, 'first\n')
    await holdLockInChild(200, 'from-other-app')
    const seen = await withFileLock(target, () => readFileSync(target, 'utf8'))
    expect(seen).toBe('first\nfrom-other-app\n')
  })

  it('does not block the event loop while it waits', async () => {
    await holdLockInChild(300)
    let ticks = 0
    const timer = setInterval(() => ticks++, 20)
    await withFileLock(target, () => undefined)
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(3)
  })

  it('takes over a stale lock left by a process that died', async () => {
    writeFileSync(`${target}.lock`, 'dead')
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${target}.lock`, old, old)
    expect(await withFileLock(target, () => 'ok', { staleMs: 30_000 })).toBe('ok')
    expect(existsSync(`${target}.lock`)).toBe(false)
    expect(readdirSync(dir).filter((f) => f.endsWith('.takeover'))).toEqual([])
  })

  it('lets only one waiter at a time in when several find the same stale lock', async () => {
    for (let round = 0; round < 5; round++) {
      writeFileSync(`${target}.lock`, 'dead')
      const old = new Date(Date.now() - 60_000)
      utimesSync(`${target}.lock`, old, old)
      let inside = 0
      let most = 0
      await Promise.all(
        Array.from({ length: 6 }, () =>
          withFileLock(
            target,
            async () => {
              inside++
              most = Math.max(most, inside)
              await new Promise((r) => setTimeout(r, 5))
              inside--
            },
            { retryMs: 1 }
          )
        )
      )
      expect(most).toBe(1)
      expect(existsSync(`${target}.lock`)).toBe(false)
    }
  })

  it('gives up on a busy lock after the timeout without running the callback', async () => {
    writeFileSync(`${target}.lock`, 'busy')
    let ran = false
    await expect(
      withFileLock(
        target,
        () => {
          ran = true
        },
        { timeoutMs: 80, retryMs: 10 }
      )
    ).rejects.toThrow(/being saved by another Houston window/)
    expect(ran).toBe(false)
    expect(readFileSync(`${target}.lock`, 'utf8')).toBe('busy') // not ours to remove
  })

  it('leaves a lock it no longer owns in place', async () => {
    await withFileLock(target, () => {
      writeFileSync(`${target}.lock`, 'someone-else') // ours was taken over meanwhile
    })
    expect(readFileSync(`${target}.lock`, 'utf8')).toBe('someone-else')
  })
})

const realFs = { writeFile: fsp.writeFile, readFile: fsp.readFile, unlink: fsp.unlink }

/**
 * Make `fs.promises[method]` on `path` fail with `errCode` on the calls `fails`
 * picks (all of them by default, numbered from 1), passing every other call through.
 * Returns a live count of the calls it saw on `path`.
 */
function failOn(
  method: keyof typeof realFs,
  path: string,
  errCode: string,
  fails: (call: number) => boolean = () => true
): { calls: number } {
  const real = realFs[method] as (...args: unknown[]) => Promise<unknown>
  const seen = { calls: 0 }
  vi.spyOn(fsp, method).mockImplementation(((p: unknown, ...rest: unknown[]) => {
    if (p !== path) return real.call(fsp, p, ...rest)
    seen.calls++
    if (!fails(seen.calls)) return real.call(fsp, p, ...rest)
    return Promise.reject(Object.assign(new Error(`${errCode}: injected, open '${path}'`), { code: errCode, path }))
  }) as never)
  return seen
}

// Windows refuses an exclusive create of a lock that another waiter has just
// unlinked while some handle on it is still open (the file is "delete pending"), and
// says EPERM instead of EEXIST. These inject that refusal, so every OS runs them.
describe('withFileLock with Windows file errors', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries a create Windows refuses with %s, then takes the lock', async (errCode) => {
    const create = failOn('writeFile', `${target}.lock`, errCode, (n) => n <= 2)
    expect(await withFileLock(target, () => 'ok', { platform: 'win32', retryMs: 1 })).toBe('ok')
    expect(create.calls).toBe(3)
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('still lets only one waiter in at a time when Windows refuses some creates', async () => {
    failOn('writeFile', `${target}.lock`, 'EPERM', (n) => n % 3 === 0)
    let inside = 0
    let most = 0
    let done = 0
    await Promise.all(
      Array.from({ length: 6 }, () =>
        withFileLock(
          target,
          async () => {
            inside++
            most = Math.max(most, inside)
            await new Promise((r) => setTimeout(r, 5))
            inside--
            done++
          },
          { platform: 'win32', retryMs: 1 }
        )
      )
    )
    expect(done).toBe(6)
    expect(most).toBe(1)
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('throws the refusal itself if Windows keeps refusing until the timeout', async () => {
    const create = failOn('writeFile', `${target}.lock`, 'EPERM')
    let ran = false
    await expect(
      withFileLock(
        target,
        () => {
          ran = true
        },
        { platform: 'win32', timeoutMs: 60, retryMs: 5 }
      )
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(ran).toBe(false)
    expect(create.calls).toBeGreaterThan(1)
  })

  it('throws EPERM at once on other platforms, where it is a real permission error', async () => {
    const create = failOn('writeFile', `${target}.lock`, 'EPERM')
    await expect(withFileLock(target, () => 'ok', { platform: 'linux', retryMs: 1 })).rejects.toMatchObject({
      code: 'EPERM'
    })
    expect(create.calls).toBe(1)
  })

  it('throws an error that is not a busy file at once on Windows too', async () => {
    const create = failOn('writeFile', `${target}.lock`, 'ENOENT') // the folder is gone
    await expect(withFileLock(target, () => 'ok', { platform: 'win32', retryMs: 1 })).rejects.toMatchObject({
      code: 'ENOENT'
    })
    expect(create.calls).toBe(1)
  })

  it('waits out a lock it cannot read instead of spinning past the timeout', async () => {
    writeFileSync(`${target}.lock`, 'busy')
    failOn('readFile', `${target}.lock`, 'EBUSY')
    await expect(
      withFileLock(target, () => 'ok', { platform: 'win32', timeoutMs: 80, retryMs: 10 })
    ).rejects.toThrow(/being saved by another Houston window/)
    expect(readFileSync(`${target}.lock`, 'utf8')).toBe('busy')
  })

  it('keeps trying to remove its lock while Windows reports it busy', async () => {
    const remove = failOn('unlink', `${target}.lock`, 'EBUSY', (n) => n <= 2)
    expect(await withFileLock(target, () => 'ok', { platform: 'win32', retryMs: 1 })).toBe('ok')
    expect(remove.calls).toBe(3)
    expect(existsSync(`${target}.lock`)).toBe(false)
  })

  it('keeps trying to remove the takeover guard while Windows reports it busy', async () => {
    writeFileSync(`${target}.lock`, 'dead')
    const old = new Date(Date.now() - 60_000)
    utimesSync(`${target}.lock`, old, old)
    const remove = failOn('unlink', `${target}.lock.takeover`, 'EPERM', (n) => n === 1)
    expect(await withFileLock(target, () => 'ok', { platform: 'win32', retryMs: 1 })).toBe('ok')
    expect(remove.calls).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  })
})
