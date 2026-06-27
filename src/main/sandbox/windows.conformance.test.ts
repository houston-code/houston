import { describe, it, expect } from 'vitest'
import { selectBackend } from './select'
import { runWithBackend } from './shared'
import type { SandboxRunOptions } from './contract'

/**
 * Windows backend conformance — runs ONLY on a real `windows-latest` CI host (skipped
 * everywhere else, including the macOS developer machine). It asserts the DECLARED
 * contract, never a confinement Windows can't deliver: the backend reports
 * `sandboxed: false`, a command actually runs with the right exit code, and a timeout
 * settles the call (the tree is reaped via taskkill). Filesystem-write confinement is
 * deliberately NOT asserted — there is none on Windows, and `sandboxed: false` says so.
 */

const d = process.platform === 'win32' ? describe : describe.skip

d('windows backend conformance (real)', () => {
  const backend = selectBackend()
  const run = (command: string, over: Partial<SandboxRunOptions> = {}) =>
    runWithBackend(backend, {
      command,
      cwd: process.cwd(),
      workspace: process.cwd(),
      roots: [process.cwd()],
      allowNetwork: false,
      timeoutMs: 20_000,
      ...over
    })

  it('selected the Windows backend and reports sandboxed:false (no OS filesystem sandbox)', async () => {
    expect(backend.id).toBe('windows')
    const r = await run('echo houston-ok')
    expect(r.sandboxed).toBe(false)
  })

  it('runs a command and captures stdout', async () => {
    const r = await run('echo houston-conformance-ok')
    expect(r.stdout).toContain('houston-conformance-ok')
    expect(r.exitCode).toBe(0)
  })

  it('propagates a non-zero exit code', async () => {
    const r = await run('exit 7')
    expect(r.exitCode).toBe(7)
  })

  it('a timeout settles the call (tree reaped)', async () => {
    // Cross-shell delay: bash `sleep`, cmd `ping` as a timer.
    const sleepCmd = backend.supportsSession ? 'sleep 30' : 'ping -n 30 127.0.0.1 >NUL'
    const r = await run(sleepCmd, { timeoutMs: 600 })
    expect(r.timedOut).toBe(true)
  })
})
