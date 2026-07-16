import { describe, expect, it, vi } from 'vitest'

// Drive sandbox availability and the run result so the "ran unconfined" signal can
// be exercised on any platform (a real `sandbox-exec` only exists on macOS). The
// rest of the sandbox module (e.g. clampToolResult) stays real.
const h = vi.hoisted(() => ({
  available: true,
  sandboxed: true,
  timedOut: false,
  lastOpts: undefined as { timeoutMs?: number; egressProxy?: { tcpPort: number } } | undefined,
  lastSpawnOpts: undefined as { egressProxy?: { tcpPort: number } } | undefined
}))

vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    sandboxAvailable: () => h.available,
    runSandboxed: async (opts: { timeoutMs?: number }) => {
      h.lastOpts = opts
      return {
        stdout: 'out',
        stderr: '',
        exitCode: h.timedOut ? null : 0,
        timedOut: h.timedOut,
        sandboxed: h.sandboxed
      }
    },
    spawnSandboxed: (opts: { egressProxy?: { tcpPort: number } }) => {
      h.lastSpawnOpts = opts
      const child: any = new EventEmitter()
      child.pid = 1234
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      return child
    }
  }
})

import { getTool, UNSANDBOXED_SHELL_NOTE, type ToolContext } from './tools'

const ctx: ToolContext = { workspace: '/ws', allowNetwork: false }
const runShell = (args: Record<string, unknown>): Promise<string> =>
  getTool('run_shell')!.execute(args, ctx)

describe('run_shell surfaces the honest sandbox signal', () => {
  it('appends no note when the foreground command ran confined', async () => {
    h.available = true
    h.sandboxed = true
    const out = await runShell({ command: 'echo hi' })
    expect(out).not.toContain(UNSANDBOXED_SHELL_NOTE)
    expect(out).toContain('[exit code: 0]')
  })

  it('warns when a foreground command ran WITHOUT the sandbox', async () => {
    h.available = false
    h.sandboxed = false
    const out = await runShell({ command: 'echo hi' })
    expect(out).toContain(UNSANDBOXED_SHELL_NOTE)
  })

  it('appends no note when a background shell is confined', async () => {
    h.available = true
    h.sandboxed = true
    const out = await runShell({ command: 'sleep 1', background: true })
    expect(out).toMatch(/Started background shell \w+/)
    expect(out).not.toContain(UNSANDBOXED_SHELL_NOTE)
  })

  it('warns when a background shell starts WITHOUT the sandbox', async () => {
    h.available = false
    h.sandboxed = false
    const out = await runShell({ command: 'sleep 1', background: true })
    expect(out).toMatch(/Started background shell \w+/)
    expect(out).toContain(UNSANDBOXED_SHELL_NOTE)
  })

  it('describes the sandbox without hardcoding one platform (runs on Linux/Windows too)', () => {
    const description = getTool('run_shell')!.schema.description
    expect(description).not.toMatch(/macOS|Seatbelt/)
    expect(UNSANDBOXED_SHELL_NOTE).not.toMatch(/macOS|Seatbelt/)
  })
})

describe('run_shell foreground timeout', () => {
  it('threads timeout_seconds through to the sandbox runner as timeoutMs', async () => {
    h.available = true
    h.sandboxed = true
    h.timedOut = false
    await runShell({ command: 'npm install', timeout_seconds: 480 })
    expect(h.lastOpts?.timeoutMs).toBe(480_000)
  })

  it('leaves timeoutMs unset (sandbox default) when timeout_seconds is omitted', async () => {
    await runShell({ command: 'echo hi' })
    expect(h.lastOpts?.timeoutMs).toBeUndefined()
  })

  it('surfaces an actionable hint when a command times out', async () => {
    h.timedOut = true
    const out = await runShell({ command: 'npm install' })
    expect(out).toContain('timed out after 300s')
    expect(out).toContain('timeout_seconds')
    expect(out).toContain('background:true')
    h.timedOut = false
  })
})

describe('run_shell threads the egress-proxy endpoints into the sandbox', () => {
  const proxyCtx: ToolContext = {
    workspace: '/ws',
    allowNetwork: true,
    egressProxy: { tcpPort: 9137 }
  }

  it('foreground commands carry ctx.egressProxy to the runner', async () => {
    await getTool('run_shell')!.execute({ command: 'curl https://x/' }, proxyCtx)
    expect(h.lastOpts?.egressProxy).toEqual({ tcpPort: 9137 })
  })

  it('background shells carry ctx.egressProxy to the spawner', async () => {
    await getTool('run_shell')!.execute({ command: 'npm run dev', background: true }, proxyCtx)
    expect(h.lastSpawnOpts?.egressProxy).toEqual({ tcpPort: 9137 })
  })

  it('an absent egressProxy (mode "all") threads as undefined — legacy full network', async () => {
    await runShell({ command: 'echo hi' })
    expect(h.lastOpts?.egressProxy).toBeUndefined()
  })
})
