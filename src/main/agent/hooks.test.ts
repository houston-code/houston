import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HOOK_ENV_PAYLOAD_MAX_BYTES, matchingHooks, runHooks } from './hooks'
import type { Hook } from '@shared/types'
import { runSandboxed, type SandboxRunOptions, type SandboxRunResult } from '../sandbox'

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

  describe('large payloads', () => {
    // Over the OS limits (Linux refuses a single variable past 128 KB, macOS the whole
    // environment past ~1 MB), the hook used to fail to launch with `spawn E2BIG`,
    // which escaped and ended the turn.
    const big = 'x'.repeat(HOOK_ENV_PAYLOAD_MAX_BYTES + 1)

    /** Runner that captures each call's env and what its payload files held at run time. */
    function capturing(): {
      run: (o: SandboxRunOptions) => Promise<SandboxRunResult>
      envs: NodeJS.ProcessEnv[]
      files: Record<string, { content: string; mode: number }>
    } {
      const envs: NodeJS.ProcessEnv[] = []
      const files: Record<string, { content: string; mode: number }> = {}
      return {
        envs,
        files,
        run: async (o) => {
          envs.push(o.env ?? {})
          for (const [k, v] of Object.entries(o.env ?? {})) {
            if (k.startsWith('HOUSTON_') && k.endsWith('_FILE') && v) {
              files[k] = { content: readFileSync(v, 'utf8'), mode: statSync(v).mode & 0o777 }
            }
          }
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false, sandboxed: true }
        }
      }
    }

    it('keeps a small payload in its environment variable, with no file', async () => {
      const c = capturing()
      await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'c' }],
        'PreToolUse',
        { tool: 'write_file', input: { content: 'small' } },
        '/ws',
        sig,
        c.run
      )
      expect(JSON.parse(c.envs[0].HOUSTON_TOOL_INPUT ?? '')).toEqual({ content: 'small' })
      expect(c.envs[0].HOUSTON_TOOL_INPUT_FILE).toBeUndefined()
    })

    it('moves a large tool input to a private file named by HOUSTON_TOOL_INPUT_FILE, then removes it', async () => {
      const c = capturing()
      const r = await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'c' }],
        'PreToolUse',
        { tool: 'write_file', input: { content: big } },
        '/ws',
        sig,
        c.run
      )
      expect(r.blocked).toBe(false)
      const env = c.envs[0]
      expect(env.HOUSTON_TOOL_INPUT).toBeUndefined()
      const file = env.HOUSTON_TOOL_INPUT_FILE as string
      expect(JSON.parse(c.files.HOUSTON_TOOL_INPUT_FILE.content)).toEqual({ content: big })
      if (process.platform !== 'win32') {
        expect(c.files.HOUSTON_TOOL_INPUT_FILE.mode).toBe(0o600)
      }
      expect(existsSync(file)).toBe(false)
      expect(existsSync(dirname(file))).toBe(false)
    })

    it('moves a large tool result and a large prompt the same way, each on its own', async () => {
      const post = capturing()
      await runHooks(
        [{ event: 'PostToolUse', matcher: '*', command: 'c' }],
        'PostToolUse',
        { tool: 'run_shell', input: { command: 'ls' }, result: big },
        '/ws',
        sig,
        post.run
      )
      // The small input stays inline even though the result went to a file.
      expect(JSON.parse(post.envs[0].HOUSTON_TOOL_INPUT ?? '')).toEqual({ command: 'ls' })
      expect(post.envs[0].HOUSTON_TOOL_RESULT).toBeUndefined()
      expect(post.files.HOUSTON_TOOL_RESULT_FILE.content).toBe(big)

      const submit = capturing()
      await runHooks(
        [{ event: 'UserPromptSubmit', matcher: '*', command: 'c' }],
        'UserPromptSubmit',
        { tool: 'UserPromptSubmit', input: {}, prompt: big },
        '/ws',
        sig,
        submit.run
      )
      expect(submit.envs[0].HOUSTON_USER_PROMPT).toBeUndefined()
      expect(submit.files.HOUSTON_USER_PROMPT_FILE.content).toBe(big)
    })

    it('never hands a hook a payload inherited from the environment Houston was launched with', async () => {
      const saved = { ...process.env }
      process.env.HOUSTON_TOOL_RESULT = 'stale result'
      process.env.HOUSTON_TOOL_INPUT_FILE = '/tmp/stale.txt'
      try {
        const c = capturing()
        await runHooks(
          [{ event: 'PreToolUse', matcher: '*', command: 'c' }],
          'PreToolUse',
          { tool: 'read_file', input: { path: 'a' } },
          '/ws',
          sig,
          c.run
        )
        expect(c.envs[0].HOUSTON_TOOL_RESULT).toBeUndefined()
        expect(c.envs[0].HOUSTON_TOOL_INPUT_FILE).toBeUndefined()
      } finally {
        process.env = saved
      }
    })

    it('fails a blocking hook closed when it cannot be launched, instead of throwing', async () => {
      const throwing = async (): Promise<SandboxRunResult> => {
        throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' })
      }
      const pre = await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'guard --token secret' }],
        'PreToolUse',
        { tool: 'write_file', input: {} },
        '/ws',
        sig,
        throwing
      )
      expect(pre.blocked).toBe(true)
      expect(pre.approved).toBe(false)
      expect(pre.message).toContain('could not be started: spawn E2BIG')
      // The command (which can hold a token) is not echoed back.
      expect(pre.message).not.toContain('secret')

      const post = await runHooks(
        [{ event: 'PostToolUse', matcher: '*', command: 'log' }],
        'PostToolUse',
        { tool: 'write_file', input: {}, result: 'ok' },
        '/ws',
        sig,
        throwing
      )
      expect(post.blocked).toBe(false)
      expect(post.message).toContain('could not be started')
    })

    // A real launch: a 2 MB input is over the limit on every OS. The hook reads its
    // input from the file and reports the size; before, spawn threw E2BIG.
    it.skipIf(process.platform === 'win32')('runs a real hook whose input is far over the OS limit', async () => {
      const ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-hook-ws-')))
      const input = { content: 'y'.repeat(2_000_000) }
      const r = await runHooks(
        [{ event: 'PreToolUse', matcher: '*', command: 'wc -c < "$HOUSTON_TOOL_INPUT_FILE"' }],
        'PreToolUse',
        { tool: 'write_file', input },
        ws,
        sig,
        runSandboxed
      )
      expect(r.blocked).toBe(false)
      expect(Number(r.message.trim())).toBe(Buffer.byteLength(JSON.stringify(input)))
    }, 30_000)
  })
})
