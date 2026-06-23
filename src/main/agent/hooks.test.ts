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
})

/** Fake sandbox runner: exit code keyed by command; records env. */
function fakeRunner(
  exit: Record<string, number>,
  seen?: SandboxRunOptions[]
): (o: SandboxRunOptions) => Promise<SandboxRunResult> {
  return async (o) => {
    seen?.push(o)
    return {
      stdout: `out:${o.command}`,
      stderr: '',
      exitCode: exit[o.command] ?? 0,
      timedOut: false,
      sandboxed: true
    }
  }
}

const sig = new AbortController().signal

describe('runHooks', () => {
  it('no matching hooks → not blocked, no spawn', async () => {
    const seen: SandboxRunOptions[] = []
    const r = await runHooks([], 'PreToolUse', { tool: 'read_file', input: {} }, '/ws', sig, fakeRunner({}, seen))
    expect(r).toEqual({ blocked: false, message: '' })
    expect(seen).toHaveLength(0)
  })

  it('PreToolUse blocks on non-zero exit', async () => {
    const r = await runHooks(
      [{ event: 'PreToolUse', matcher: 'write_file', command: 'deny' }],
      'PreToolUse',
      { tool: 'write_file', input: { path: 'x' } },
      '/ws',
      sig,
      fakeRunner({ deny: 2 })
    )
    expect(r.blocked).toBe(true)
    expect(r.message).toContain('out:deny')
  })

  it('PostToolUse never blocks but collects output', async () => {
    const r = await runHooks(
      [{ event: 'PostToolUse', matcher: '*', command: 'fmt' }],
      'PostToolUse',
      { tool: 'edit_file', input: {}, result: 'edited' },
      '/ws',
      sig,
      fakeRunner({ fmt: 1 }) // non-zero, but PostToolUse doesn't block
    )
    expect(r.blocked).toBe(false)
    expect(r.message).toContain('out:fmt')
  })

  it('passes tool context via HOUSTON_* env vars', async () => {
    const seen: SandboxRunOptions[] = []
    await runHooks(
      [{ event: 'PreToolUse', matcher: '*', command: 'c' }],
      'PreToolUse',
      { tool: 'run_shell', input: { command: 'ls' } },
      '/ws',
      sig,
      fakeRunner({}, seen)
    )
    expect(seen[0].env?.HOUSTON_TOOL_NAME).toBe('run_shell')
    expect(seen[0].env?.HOUSTON_HOOK_EVENT).toBe('PreToolUse')
    expect(JSON.parse(seen[0].env?.HOUSTON_TOOL_INPUT ?? '{}')).toEqual({ command: 'ls' })
    expect(seen[0].allowNetwork).toBe(false)
  })
})
