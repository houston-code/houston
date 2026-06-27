import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { selectBackend } from './select'
import { runWithBackend } from './shared'
import type { SandboxRunOptions } from './contract'

/**
 * Behavioral sandbox conformance — the SAME assertions run against whatever backend
 * the host selects: Seatbelt on macOS (for real), bubblewrap on a Linux CI leg once
 * it lands, and the unconfined backend elsewhere. Confinement-only guarantees (C2
 * write-outside-denied, C4 network-gated) are SKIPPED — not failed — on a backend
 * that reports `sandboxed: false`, so this suite is green on the Linux unit leg while
 * running for real on the macOS leg. Lifecycle guarantees (C1/C3/C5/C6/C7) run on
 * every backend.
 *
 * Network probe (C4): this must hold across backends with different denial mechanics.
 *  - DENIED targets a NON-loopback, non-routable address (TEST-NET-1, 192.0.2.1). A
 *    Seatbelt-denied connect surfaces "operation not permitted"; a bubblewrap empty
 *    network namespace surfaces "network is unreachable" / "no route to host" (its
 *    loopback stays up, so a loopback target would NOT prove the gate). Either is a
 *    denial signature.
 *  - ALLOWED targets a closed LOOPBACK port (always reachable when the net stack is
 *    shared), surfacing "connection refused" — it reached the stack.
 * We assert on the stderr signature, not the exit code — a failed `/dev/tcp` redirect
 * does not reliably propagate a non-zero top-level exit.
 */
const NETWORK_DENIED_RE = /operation not permitted|not permitted|network is unreachable|no route to host/i

const backend = selectBackend()
const enforces = backend.sandboxed
const itEnforced = enforces ? it : it.skip

/** Single-quote a POSIX path (these tests only run on POSIX-shell backends). */
function sq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

// Skipped on Windows: these assertions are POSIX-shell / POSIX-path shaped. The Windows
// backend is exercised by windows.conformance.test.ts instead.
describe.skipIf(process.platform === 'win32')(`sandbox conformance [backend=${backend.id} sandboxed=${enforces}]`, () => {
  // Belt-and-suspenders for the dedicated CI leg that is SUPPOSED to exercise a real
  // OS sandbox: assert the confining backend was actually selected, so a misconfigured
  // runner (e.g. bubblewrap installed but unprivileged userns blocked) fails LOUDLY
  // instead of silently skipping the confinement assertions and reporting green.
  if (process.env.HOUSTON_REQUIRE_SANDBOX === '1') {
    it('a real OS sandbox backend is active (HOUSTON_REQUIRE_SANDBOX)', () => {
      expect(enforces).toBe(true)
      expect(backend.id).not.toBe('none')
    })
  }

  let workspace: string
  let outside: string

  const run = (command: string, over: Partial<SandboxRunOptions> = {}) =>
    runWithBackend(backend, {
      command,
      cwd: workspace,
      workspace,
      roots: [workspace],
      allowNetwork: false,
      timeoutMs: 20_000,
      ...over
    })

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'houston-conf-ws-'))
    // A path GUARANTEED outside the workspace and temp dirs (so a confining backend
    // must deny writing it). Under $HOME, which the Seatbelt profile does not make writable.
    outside = join(homedir(), `.houston-conf-out-${randomUUID().slice(0, 8)}`)
  })

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it('C1 writes inside the workspace succeed', async () => {
    const f = join(workspace, 'probe.txt')
    const r = await run(`printf hi > ${sq(f)}`)
    expect(r.exitCode).toBe(0)
    expect(existsSync(f)).toBe(true)
  })

  it('C3 reads outside the roots succeed', async () => {
    const r = await run('cat /etc/hosts > /dev/null')
    expect(r.exitCode).toBe(0)
  })

  it('C5 the command can fork/exec children', async () => {
    const r = await run('ls / | wc -l')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toMatch(/^\d+$/)
  })

  it('C6 a timeout kills the command and settles', async () => {
    const r = await run('sleep 30', { timeoutMs: 400 })
    expect(r.timedOut).toBe(true)
  })

  it('C7 output is capped at both ends with a marker', async () => {
    // > 2 MB on stdout, with a distinct trailing sentinel printed last.
    const r = await run(`head -c 2200000 /dev/zero | tr '\\0' x; printf '\\nEND_SENTINEL'`)
    expect(r.stdout).toContain('END_SENTINEL') // the tail (actionable last line) survives
    expect(r.stdout).toMatch(/bytes truncated/) // the middle was dropped
  })

  itEnforced('C2 writes outside the roots are denied', async () => {
    const f = join(outside, 'nope.txt')
    const r = await run(`mkdir -p ${sq(outside)} && printf hi > ${sq(f)}`)
    expect(r.exitCode).not.toBe(0)
    expect(existsSync(f)).toBe(false)
  })

  itEnforced('C4a network is denied when allowNetwork=false', async () => {
    // 192.0.2.1 is non-loopback + non-routable (TEST-NET-1): denied by every backend.
    const r = await run('exec 3<>/dev/tcp/192.0.2.1/80', { allowNetwork: false })
    expect(r.stderr).toMatch(NETWORK_DENIED_RE)
  })

  itEnforced('C4b network reaches the stack when allowNetwork=true', async () => {
    // Loopback is reachable whenever the net stack is shared; the closed port refuses.
    const r = await run('exec 3<>/dev/tcp/127.0.0.1/1', { allowNetwork: true })
    expect(r.stderr).toMatch(/connection refused/i)
  })
})
