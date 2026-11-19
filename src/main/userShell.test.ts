import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { captureUserShell } from './userShell'

const dir = mkdtempSync(join(tmpdir(), 'houston-usershell-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('captureUserShell', () => {
  it('collects output and the exit code', async () => {
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
