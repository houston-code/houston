import { describe, expect, it, vi } from 'vitest'

// Drive sandbox availability and the run result so the "ran unconfined" signal can
// be exercised on any platform (a real `sandbox-exec` only exists on macOS). The
// rest of the sandbox module (e.g. clampToolResult) stays real.
const h = vi.hoisted(() => ({ available: true, sandboxed: true }))

vi.mock('../sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sandbox')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    sandboxAvailable: () => h.available,
    runSandboxed: async () => ({
      stdout: 'out',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      sandboxed: h.sandboxed
    }),
    spawnSandboxed: () => {
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
})
