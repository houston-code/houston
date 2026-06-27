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
 * Network probe (C4): a sandbox-denied outbound connect surfaces "operation not
 * permitted" on stderr; an allowed connect to a closed loopback port surfaces
 * "connection refused" (it reached the network stack). We assert on the stderr
 * signature, not the exit code — a failed `/dev/tcp` redirect does not reliably
 * propagate a non-zero top-level exit.
 */

const backend = selectBackend()
const enforces = backend.sandboxed
const itEnforced = enforces ? it : it.skip

/** Single-quote a POSIX path (these tests only run on POSIX-shell backends). */
function sq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

describe(`sandbox conformance [backend=${backend.id} sandboxed=${enforces}]`, () => {
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
    const r = await run('exec 3<>/dev/tcp/127.0.0.1/1', { allowNetwork: false })
    expect(r.stderr).toMatch(/operation not permitted/i)
  })

  itEnforced('C4b network reaches the stack when allowNetwork=true', async () => {
    const r = await run('exec 3<>/dev/tcp/127.0.0.1/1', { allowNetwork: true })
    expect(r.stderr).toMatch(/connection refused/i)
  })
})
