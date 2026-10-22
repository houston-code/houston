import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
