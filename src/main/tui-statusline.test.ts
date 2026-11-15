import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  linkedWorktreeRoot,
  parseStatusLineConfig,
  resolveStatusLine,
  sanitizeStatusOutput,
  STATUS_LINE_FIELDS,
  STATUS_LINE_MAX_LINES,
  STATUS_LINE_TIMEOUT_MS,
  StatusLineRunner,
  type StatusLineExec,
  type StatusLinePayload
} from './tui-statusline'
import type { ShellCapture } from './userShell'

const ESC = '\x1b'

const ok = (stdout: string): ShellCapture => ({ exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false })

const payload: StatusLinePayload = {
  version: '1.0.0',
  sessionId: null,
  title: null,
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  effort: 'medium',
  approvalMode: 'ask',
  cwd: '/work/app',
  branch: 'main',
  worktree: null,
  contextPercent: null,
  contextTokens: 0,
  cost: { usd: 0, inputTokens: 0, outputTokens: 0, unknown: false },
  vimMode: null
}

describe('parseStatusLineConfig', () => {
  it('takes a command and a refresh interval', () => {
    expect(parseStatusLineConfig({ command: ' ~/bin/status ', refreshSeconds: 5 })).toEqual({
      command: '~/bin/status',
      refreshSeconds: 5
    })
  })

  it('clamps the interval and drops a bad one', () => {
    expect(parseStatusLineConfig({ command: 'x', refreshSeconds: 0.2 })?.refreshSeconds).toBe(1)
    expect(parseStatusLineConfig({ command: 'x', refreshSeconds: 1e9 })?.refreshSeconds).toBe(3600)
    expect(parseStatusLineConfig({ command: 'x', refreshSeconds: -3 })).toEqual({ command: 'x' })
    expect(parseStatusLineConfig({ command: 'x', refreshSeconds: '5' })).toEqual({ command: 'x' })
  })

  it('refuses anything without a usable command', () => {
    expect(parseStatusLineConfig(undefined)).toBeNull()
    expect(parseStatusLineConfig('echo hi')).toBeNull()
    expect(parseStatusLineConfig({ command: '   ' })).toBeNull()
    expect(parseStatusLineConfig({ command: 42 })).toBeNull()
    expect(parseStatusLineConfig([{ command: 'x' }])).toBeNull()
    expect(parseStatusLineConfig({ command: 'x'.repeat(5000) })).toBeNull()
  })
})

describe('resolveStatusLine', () => {
  it("prefers the user's command and never asks about trust then", () => {
    const trusted = vi.fn(() => true)
    expect(resolveStatusLine({ command: 'mine' }, { command: 'theirs' }, trusted)).toEqual({ command: 'mine', source: 'user' })
    expect(trusted).not.toHaveBeenCalled()
  })

  it("uses a project's command only in a trusted folder", () => {
    expect(resolveStatusLine(undefined, { command: 'theirs' }, () => false)).toBeNull()
    expect(resolveStatusLine(undefined, { command: 'theirs' }, () => true)).toEqual({ command: 'theirs', source: 'project' })
    expect(resolveStatusLine(undefined, null, () => true)).toBeNull()
  })
})

describe('sanitizeStatusOutput', () => {
  it('keeps the first lines, without trailing blank ones', () => {
    expect(sanitizeStatusOutput('one\ntwo\n\n')).toEqual(['one', 'two'])
    expect(sanitizeStatusOutput('a\nb\nc\nd\ne\n')).toHaveLength(STATUS_LINE_MAX_LINES)
    expect(sanitizeStatusOutput('a\r\nb\r\n')).toEqual(['a', 'b'])
  })

  it('keeps colour and resets it at the end of the row', () => {
    expect(sanitizeStatusOutput(`${ESC}[32mgreen${ESC}[0m\n`)).toEqual([`${ESC}[32mgreen${ESC}[0m${ESC}[0m`])
  })

  it('removes every other escape sequence and control character', () => {
    const evil = `a${ESC}[2Jb${ESC}[1Ac${ESC}]52;c;ZXZpbA==\x07d${ESC}]0;title${ESC}\\e\x07f\rg${ESC}Ph${ESC}\\i\x9b2J`
    const [row] = sanitizeStatusOutput(evil)
    expect(row).toBe('abcdefgi2J')
    // eslint-disable-next-line no-control-regex -- asserting no control characters survive
    expect(row).not.toMatch(/[\x00-\x1f\x7f-\x9f]/)
  })

  it('is empty for output with nothing visible', () => {
    expect(sanitizeStatusOutput('')).toEqual([])
    expect(sanitizeStatusOutput(`\n  \n${ESC}[31m${ESC}[0m\n`)).toEqual([])
  })
})

describe('linkedWorktreeRoot', () => {
  const fs = (entries: Record<string, 'file' | 'dir'>) => (p: string) =>
    entries[p] ? { isFile: () => entries[p] === 'file' } : null
  // Paths as this platform writes them (backslashes on Windows), as the walk builds them.
  const at = (...segs: string[]) => join(sep, ...segs)

  it('finds the linked worktree a folder is in', () => {
    expect(linkedWorktreeRoot(at('repo', 'wt', 'src', 'app'), fs({ [at('repo', 'wt', '.git')]: 'file' }))).toBe(at('repo', 'wt'))
  })

  it('is null in a main checkout or outside a repository', () => {
    expect(linkedWorktreeRoot(at('repo', 'src'), fs({ [at('repo', '.git')]: 'dir' }))).toBeNull()
    expect(linkedWorktreeRoot(at('tmp', 'x'), fs({}))).toBeNull()
  })
})

describe('StatusLineRunner', () => {
  const config = { command: 'status', source: 'user' as const }

  it('runs the command with the payload on stdin and keeps its rows', async () => {
    const exec = vi.fn<StatusLineExec>(async () => ok('main · 12%\n'))
    const changed = vi.fn()
    const r = new StatusLineRunner(config, exec, changed)
    await r.refresh(payload)
    expect(r.lines()).toEqual(['main · 12%'])
    expect(changed).toHaveBeenCalledTimes(1)
    const [command, input, opts] = exec.mock.calls[0]
    expect(command).toBe('status')
    expect(JSON.parse(input)).toEqual(payload)
    expect(opts.timeoutMs).toBe(STATUS_LINE_TIMEOUT_MS)
  })

  it('keeps the last good output when a run fails, times out or prints nothing', async () => {
    const results: Array<ShellCapture | Error> = [
      ok('good\n'),
      { ...ok(''), exitCode: 2 },
      { ...ok('late\n'), timedOut: true, exitCode: 124 },
      ok('\n'),
      new Error('spawn ENOENT')
    ]
    const exec: StatusLineExec = async () => {
      const next = results.shift()!
      if (next instanceof Error) throw next
      return next
    }
    const r = new StatusLineRunner(config, exec)
    await r.refresh(payload)
    for (const reason of ['exited with code 2', 'timed out', 'printed nothing', 'could not run']) {
      await r.refresh(payload)
      expect(r.lines()).toEqual(['good'])
      expect(r.lastFailure()?.reason).toContain(reason)
    }
  })

  it('does not report a change when the output is the same', async () => {
    const changed = vi.fn()
    const r = new StatusLineRunner(config, async () => ok('same\n'), changed)
    await r.refresh(payload)
    await r.refresh(payload)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('runs one at a time, then once more with the newest payload', async () => {
    let release: () => void = () => {}
    const inputs: string[] = []
    const exec: StatusLineExec = (_c, input) => {
      inputs.push(input)
      return new Promise((resolve) => {
        release = () => resolve(ok(`run ${inputs.length}\n`))
      })
    }
    const r = new StatusLineRunner(config, exec)
    const first = r.refresh(payload)
    void r.refresh({ ...payload, branch: 'b1' })
    void r.refresh({ ...payload, branch: 'b2' })
    expect(inputs).toHaveLength(1)
    release()
    await new Promise((res) => setTimeout(res, 0))
    expect(inputs).toHaveLength(2)
    expect(JSON.parse(inputs[1]).branch).toBe('b2')
    release()
    await first
    expect(r.lines()).toEqual(['run 2'])
  })

  it('documents every payload field', () => {
    expect(STATUS_LINE_FIELDS.map((f) => f.name).sort()).toEqual(Object.keys(payload).sort())
  })
})
