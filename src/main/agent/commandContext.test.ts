import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { contextCommands, findContext, hasContext } from '@shared/commandContext'
import type { ShellCapture } from '../userShell'
import { captureUserShell } from '../userShell'
import { expandCommandContext, MAX_CONTEXT_FILE_BYTES, type ExpandContextOptions } from './commandContext'

const ok = (stdout: string): ShellCapture => ({ exitCode: 0, stdout, stderr: '', timedOut: false, truncated: false })

let ws: string
let outside: string
beforeEach(() => {
  ws = realpathSync(mkdtempSync(join(tmpdir(), 'houston-ctx-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'houston-ctx-out-')))
  mkdirSync(join(ws, 'src'))
  writeFileSync(join(ws, 'src/a.ts'), 'export const a = 1\n')
  writeFileSync(join(ws, '.env'), 'TOKEN=hunter2\n')
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
})
afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const opts = (over: Partial<ExpandContextOptions> = {}): ExpandContextOptions => ({
  workspace: ws,
  roots: [ws],
  preapproved: false,
  ...over
})

describe('findContext', () => {
  it('finds shell commands and path-like @words, leaving handles and addresses alone', () => {
    const { pieces } = findContext('Diff: !`git diff --stat`. Read @src/a.ts. Ping @octocat or me@host.com, (@docs/x.md)')
    expect(pieces).toEqual([
      { kind: 'shell', command: 'git diff --stat' },
      { kind: 'file', path: 'src/a.ts' },
      { kind: 'file', path: 'docs/x.md' }
    ])
    expect(contextCommands('a !`ls` b !`pwd`')).toEqual(['ls', 'pwd'])
    expect(hasContext('plain $ARGUMENTS')).toBe(false)
    expect(hasContext("import x from '@angular/core'")).toBe(false)
  })
})

describe('expandCommandContext', () => {
  it('fills a file in, fenced and named, and puts the arguments in after', async () => {
    const r = await expandCommandContext('Review @src/a.ts for $ARGUMENTS', 'bugs', opts())
    expect(r).toEqual({ ok: true, text: 'Review Contents of `src/a.ts`:\n```\nexport const a = 1\n\n``` for bugs' })
  })

  it('keeps a path-like @word that names no file as text', async () => {
    const r = await expandCommandContext('Install @types/node', '', opts())
    expect(r).toEqual({ ok: true, text: 'Install @types/node' })
  })

  it('refuses a path outside the workspace, directly or through a symlink', async () => {
    expect(await expandCommandContext(`Read @${join(outside, 'secret.txt')}`, '', opts())).toEqual({
      ok: false,
      error: expect.stringContaining('is outside this project')
    })
    expect(await expandCommandContext('Read @../x/secret.txt', '', opts())).toMatchObject({ ok: false })
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'))
    expect(await expandCommandContext('Read @link.txt', '', opts())).toMatchObject({
      ok: false,
      error: expect.stringContaining('outside this project')
    })
  })

  it('asks before reading a credential file, even for a trusted command, and refuses with no one to ask', async () => {
    const confirm = vi.fn(async () => true)
    const r = await expandCommandContext('Use @.env.', '', opts({ preapproved: true, confirm }))
    expect(confirm).toHaveBeenCalledWith({ commands: [], sensitiveFiles: ['.env'] })
    expect(r.ok && r.text).toContain('TOKEN=hunter2')
    expect(await expandCommandContext('Use @.env.', '', opts({ preapproved: true }))).toEqual({
      ok: false,
      error: expect.stringContaining('credential file')
    })
  })

  it('asks for an innocent-looking link to a credential file too', async () => {
    symlinkSync(join(ws, '.env'), join(ws, 'notes.txt'))
    const confirm = vi.fn(async () => false)
    expect(await expandCommandContext('Read @notes.txt', '', opts({ preapproved: true, confirm }))).toMatchObject({ ok: false })
    expect(confirm).toHaveBeenCalledWith({ commands: [], sensitiveFiles: ['notes.txt'] })
  })

  it('caps a large file with a marker, and refuses a binary one', async () => {
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(MAX_CONTEXT_FILE_BYTES + 10))
    const r = await expandCommandContext('@big.txt', '', opts())
    expect(r.ok && r.text).toContain(`[truncated: big.txt is ${MAX_CONTEXT_FILE_BYTES + 10} bytes; only the first ${MAX_CONTEXT_FILE_BYTES} are shown]`)
    writeFileSync(join(ws, 'bin.dat'), Buffer.from([1, 0, 2]))
    expect(await expandCommandContext('@bin.dat', '', opts())).toEqual({ ok: false, error: '@bin.dat is not a text file' })
    expect(await expandCommandContext('@src/.', '', opts())).toMatchObject({ ok: false, error: expect.stringContaining('not a file') })
  })

  it('shows the exact commands and runs nothing when the user says no', async () => {
    const runShell = vi.fn(async () => ok('out'))
    const confirm = vi.fn(async () => false)
    const r = await expandCommandContext('a !`git status` b !`ls -la`', '', opts({ confirm, runShell }))
    expect(confirm).toHaveBeenCalledWith({ commands: ['git status', 'ls -la'], sensitiveFiles: [] })
    expect(runShell).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: false, error: 'not run: you declined its context' })
  })

  it('runs the commands once allowed, or without asking when preapproved', async () => {
    const runShell = vi.fn(async (c: string) => ok(`${c} says hi\n\n`))
    const confirm = vi.fn(async () => true)
    expect(await expandCommandContext('Status: !`git status`', 'x', opts({ confirm, runShell }))).toEqual({
      ok: true,
      text: 'Status: git status says hi\n\nx'
    })
    confirm.mockClear()
    await expandCommandContext('!`pwd`', '', opts({ preapproved: true, confirm, runShell }))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('refuses shell context with no one to ask, unless preapproved', async () => {
    const runShell = vi.fn(async () => ok('x'))
    expect(await expandCommandContext('!`ls`', '', opts({ runShell }))).toEqual({
      ok: false,
      error: expect.stringContaining('no one here to approve them')
    })
    expect(runShell).not.toHaveBeenCalled()
    expect(await expandCommandContext('!`ls`', '', opts({ runShell, preapproved: true }))).toEqual({ ok: true, text: 'x' })
  })

  it('stops the whole send on a failed or timed-out command', async () => {
    const fail = async (): Promise<ShellCapture> => ({ exitCode: 2, stdout: 'partial', stderr: 'boom\n', timedOut: false, truncated: false })
    expect(await expandCommandContext('a @src/a.ts !`make`', '', opts({ preapproved: true, runShell: fail }))).toEqual({
      ok: false,
      error: '`make` exited 2: boom'
    })
    const slow = async (): Promise<ShellCapture> => ({ exitCode: 124, stdout: '', stderr: '', timedOut: true, truncated: false })
    expect(await expandCommandContext('!`sleep 99`', '', opts({ preapproved: true, runShell: slow }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('was stopped')
    })
  })

  it('never puts the arguments into a command', async () => {
    const runShell = vi.fn(async () => ok('done'))
    await expandCommandContext('!`echo $1 $ARGUMENTS`', '"; rm -rf ~', opts({ preapproved: true, runShell }))
    expect(runShell).toHaveBeenCalledWith('echo $1 $ARGUMENTS')
  })
})

describe('captureUserShell', () => {
  it('collects stdout, keeps stderr apart, and reports the exit code', async () => {
    const r = await captureUserShell(ws, 'echo out; echo err >&2; exit 3', { timeoutMs: 5000, maxBytes: 1000 })
    expect(r).toMatchObject({ exitCode: 3, stdout: 'out\n', timedOut: false, truncated: false })
    expect(r.stderr).toContain('err')
  })

  it('caps output and stops a command at its time limit', async () => {
    const big = await captureUserShell(ws, 'yes | head -c 5000', { timeoutMs: 5000, maxBytes: 100 })
    expect(big.stdout).toHaveLength(100)
    expect(big.truncated).toBe(true)
    const slow = await captureUserShell(ws, 'sleep 10', { timeoutMs: 200, maxBytes: 100 })
    expect(slow.timedOut).toBe(true)
  })
})
