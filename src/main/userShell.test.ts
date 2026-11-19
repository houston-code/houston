import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureUserShell, runUserShell, userShellInForeground } from './userShell'

const dir = mkdtempSync(join(tmpdir(), 'houston-usershell-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('captureUserShell', () => {
  // POSIX shell syntax: on Windows the command runs under cmd.exe.
  it.skipIf(process.platform === 'win32')('collects output and the exit code', async () => {
    const res = await captureUserShell(dir, 'echo hi; exit 3', { timeoutMs: 5000, maxBytes: 1000 })
    expect(res).toMatchObject({ exitCode: 3, stdout: 'hi\n', timedOut: false, truncated: false })
  })

  // A helper that leaves the process group (setsid) survives the group kill and keeps
  // the output pipe open, so waiting for 'close' alone ran until it exited.
  it.skipIf(process.platform === 'win32')(
    'settles soon after the time limit even when a process that left the group holds the output open',
    async () => {
      const started = Date.now()
      const res = await captureUserShell(
        dir,
        `perl -MPOSIX -e 'fork and exit; POSIX::setsid(); sleep 4'; sleep 4`,
        { timeoutMs: 300, maxBytes: 1000 }
      )
      expect(res.timedOut).toBe(true)
      expect(res.exitCode).toBe(124)
      expect(Date.now() - started).toBeLessThan(2000)
    },
    10_000
  )
})

describe.skipIf(process.platform === 'win32')('runUserShell', () => {
  it('is in the foreground while it runs, and not after', async () => {
    expect(userShellInForeground()).toBe(false)
    const out: string[] = []
    const run = runUserShell(tmpdir(), 'echo hi', (c) => out.push(c))
    expect(userShellInForeground()).toBe(true)
    await expect(run).resolves.toBe(0)
    expect(out.join('')).toBe('hi\n')
    expect(userShellInForeground()).toBe(false)
  })

  // A Ctrl-C at a `!` command stops it with SIGINT; that was reported as a clean exit 0.
  it('reports a command stopped by a signal as 128 + n', async () => {
    await expect(runUserShell(tmpdir(), 'kill -INT $$', () => {})).resolves.toBe(130)
    expect(userShellInForeground()).toBe(false)
  })
})
