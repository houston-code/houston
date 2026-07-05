import { describe, it, expect } from 'vitest'
import { matchingHooks, runHooks } from './hooks'
import type { Hook } from '@shared/types'
import type { SandboxRunOptions, SandboxRunResult } from '../sandbox'

const hooks: Hook[] = [
  { event: 'PreToolUse', matcher: 'write_file', command: 'guard' },
  { event: 'PreToolUse', matcher: '*', command: 'audit' },
  { event: 'PostToolUse', matcher: 'edit_*', command: 'format' }
]

describe('matchingHooks', () => {
  it('filters by event and tool matcher', () => {
    expect(matchingHooks(hooks, 'PreToolUse', 'write_file').map((h) => h.command)).toEqual([
      'guard',
      'audit'
    ])
    expect(matchingHooks(hooks, 'PreToolUse', 'read_file').map((h) => h.command)).toEqual(['audit'])
    expect(matchingHooks(hooks, 'PostToolUse', 'edit_file').map((h) => h.command)).toEqual(['format'])
    expect(matchingHooks(hooks, 'PostToolUse', 'read_file')).toEqual([])
  })

  it('treats empty/“*” matcher as all', () => {
    expect(matchingHooks([{ event: 'PreToolUse', matcher: '', command: 'x' }], 'PreToolUse', 'anything')).toHaveLength(1)
  })

  it('returns [] for no hooks', () => {
    expect(matchingHooks(undefined, 'PreToolUse', 'x')).toEqual([])
  })

  it('matches lifecycle events only on empty/“*” matcher (no tool)', () => {
    const lifecycle: Hook[] = [
      { event: 'SessionStart', matcher: '*', command: 'a' },
      { event: 'SessionStart', matcher: '', command: 'b' },
      { event: 'SessionStart', matcher: 'write_file', command: 'c' },
      { event: 'Stop', matcher: '*', command: 'd' }
    ]
    expect(matchingHooks(lifecycle, 'SessionStart').map((h) => h.command)).toEqual(['a', 'b'])
    expect(matchingHooks(lifecycle, 'Stop').map((h) => h.command)).toEqual(['d'])
  })
})

/** Fake sandbox runner: result keyed by command; records the spawn options. */
function runnerFrom(
  byCommand: Record<string, Partial<SandboxRunResult>>,
  seen?: SandboxRunOptions[]
): (o: SandboxRunOptions) => Promise<SandboxRunResult> {
  return async (o) => {
    seen?.push(o)
    const r = byCommand[o.command] ?? {}
    return {
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      exitCode: r.exitCode ?? 0,
      timedOut: false,
      sandboxed: true
    }
  }
}

const sig = new AbortController().signal

describe('runHooks', () => {
  it('no matching hooks → not blocked, not approved, no spawn', async () => {
    const seen: SandboxRunOptions[] = []
    const r = await runHooks([], 'PreToolUse', { tool: 'read_file', input: {} }, '/ws', sig, runnerFrom({}, seen))
    expect(r).toEqual({ blocked: false, approved: false, message: '' })
    expect(seen).toHaveLength(0)
  })

  it('PreToolUse blocks on non-zero exit (backward compatible)', async () => {
    const r = await runHooks(
      [{ event: 'PreToolUse', matcher: 'write_file', command: 'deny' }],
      'PreToolUse',
      { tool: 'write_file', input: { path: 'x' } },
      '/ws',
      sig,
      runnerFrom({ deny: { stdout: 'nope', exitCode: 2 } })
    )
    expect(r.blocked).toBe(true)
    expect(r.message).toContain('nope')
  })

  it('PostToolUse never blocks but collects output', async () => {
    const r = await runHooks(
      [{ event: 'PostToolUse', matcher: '*', command: 'fmt' }],
      'PostToolUse',
      { tool: 'edit_file', input: {}, result: 'edited' },
      '/ws',
      sig,
      runnerFrom({ fmt: { stdout: 'formatted', exitCode: 1 } }) // non-zero, but PostToolUse doesn't block
    )
    expect(r.blocked).toBe(false)
    expect(r.message).toContain('formatted')
  })

  it('passes context via HOUSTON_* env vars', async () => {
    const seen: SandboxRunOptions[] = []
    await runHooks(
      [{ event: 'PreToolUse', matcher: '*', command: 'c' }],
      'PreToolUse',
      { tool: 'run_shell', input: { command: 'ls' } },
      '/ws',
      sig,
      runnerFrom({}, seen)
    )
    expect(seen[0].env?.HOUSTON_TOOL_NAME).toBe('run_shell')
    expect(seen[0].env?.HOUSTON_HOOK_EVENT).toBe('PreToolUse')
    expect(JSON.parse(seen[0].env?.HOUSTON_TOOL_INPUT ?? '{}')).toEqual({ command: 'ls' })
    expect(seen[0].allowNetwork).toBe(false)
  })

  it('passes the prompt via HOUSTON_USER_PROMPT for UserPromptSubmit', async () => {
    const seen: SandboxRunOptions[] = []
    await runHooks(
      [{ event: 'UserPromptSubmit', matcher: '*', command: 'c' }],
      'UserPromptSubmit',
      { tool: 'UserPromptSubmit', input: {}, prompt: 'ship it' },
      '/ws',
      sig,
      runnerFrom({}, seen)
    )
    expect(seen[0].env?.HOUSTON_USER_PROMPT).toBe('ship it')
  })

  describe('JSON directive protocol', () => {
    it('{decision:"block"} blocks and surfaces reason (not raw JSON)', async () => {
      const r = await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'j' }],
        'PreToolUse',
        { tool: 'write_file', input: {} },
        '/ws',
        sig,
        runnerFrom({ j: { stdout: JSON.stringify({ decision: 'block', reason: 'protected path' }) } })
      )
      expect(r.blocked).toBe(true)
      expect(r.message).toBe('protected path')
      expect(r.message).not.toContain('{')
    })

    it('{decision:"approve"} approves without blocking', async () => {
      const r = await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'j' }],
        'PreToolUse',
        { tool: 'run_shell', input: {} },
        '/ws',
        sig,
        runnerFrom({ j: { stdout: JSON.stringify({ decision: 'approve' }) } })
      )
      expect(r.approved).toBe(true)
      expect(r.blocked).toBe(false)
    })

    it('a block wins over an approve', async () => {
      const r = await runHooks(
        [
          { event: 'PreToolUse', matcher: '*', command: 'ok' },
          { event: 'PreToolUse', matcher: '*', command: 'no' }
        ],
        'PreToolUse',
        { tool: 'run_shell', input: {} },
        '/ws',
        sig,
        runnerFrom({
          ok: { stdout: JSON.stringify({ decision: 'approve' }) },
          no: { stdout: JSON.stringify({ decision: 'block', reason: 'blocked' }) }
        })
      )
      expect(r.blocked).toBe(true)
      expect(r.approved).toBe(false)
    })

    it('collects additionalContext across hooks and returns updatedInput (last wins)', async () => {
      const r = await runHooks(
        [
          { event: 'PreToolUse', matcher: '*', command: 'a' },
          { event: 'PreToolUse', matcher: '*', command: 'b' }
        ],
        'PreToolUse',
        { tool: 'run_shell', input: { command: 'ls' } },
        '/ws',
        sig,
        runnerFrom({
          a: { stdout: JSON.stringify({ additionalContext: 'ctx-a', updatedInput: { command: 'ls -a' } }) },
          b: { stdout: JSON.stringify({ additionalContext: 'ctx-b', updatedInput: { command: 'ls -la' } }) }
        })
      )
      expect(r.additionalContext).toBe('ctx-a\n\nctx-b')
      expect(r.updatedInput).toEqual({ command: 'ls -la' })
    })

    it('returns systemMessage', async () => {
      const r = await runHooks(
        [{ event: 'PostToolUse', matcher: '*', command: 'j' }],
        'PostToolUse',
        { tool: 'edit_file', input: {}, result: 'x' },
        '/ws',
        sig,
        runnerFrom({ j: { stdout: JSON.stringify({ systemMessage: 'heads up' }) } })
      )
      expect(r.systemMessage).toBe('heads up')
    })

    it('a non-zero exit still blocks even with a JSON directive', async () => {
      const r = await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'j' }],
        'PreToolUse',
        { tool: 'run_shell', input: {} },
        '/ws',
        sig,
        runnerFrom({ j: { stdout: JSON.stringify({ decision: 'approve' }), exitCode: 3 } })
      )
      expect(r.blocked).toBe(true)
      expect(r.approved).toBe(false)
    })

    it('non-JSON stdout is surfaced as plain feedback', async () => {
      const r = await runHooks(
        [{ event: 'PostToolUse', matcher: '*', command: 'j' }],
        'PostToolUse',
        { tool: 'edit_file', input: {}, result: 'x' },
        '/ws',
        sig,
        runnerFrom({ j: { stdout: 'plain lint output' } })
      )
      expect(r.message).toBe('plain lint output')
    })
  })

  describe('lifecycle blocking events', () => {
    it('Stop blocks on non-zero exit (force another turn)', async () => {
      const r = await runHooks(
        [{ event: 'Stop', matcher: '*', command: 'check' }],
        'Stop',
        { tool: 'Stop', input: {} },
        '/ws',
        sig,
        runnerFrom({ check: { stdout: 'run the tests first', exitCode: 1 } })
      )
      expect(r.blocked).toBe(true)
      expect(r.message).toContain('run the tests first')
    })

    it('SessionStart never blocks (only injects context)', async () => {
      const r = await runHooks(
        [{ event: 'SessionStart', matcher: '*', command: 'ctx' }],
        'SessionStart',
        { tool: 'SessionStart', input: {} },
        '/ws',
        sig,
        runnerFrom({ ctx: { stdout: JSON.stringify({ additionalContext: 'branch: main' }), exitCode: 5 } })
      )
      expect(r.blocked).toBe(false)
      expect(r.additionalContext).toBe('branch: main')
    })
  })
})
