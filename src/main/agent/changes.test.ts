import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileDiffSignature, type ChangeRevertRequest } from '@shared/changes'
import { collectChatChanges, revertChange, type RevertDeps } from './changes'
import { clearCheckpoints, flushCheckpoints, noteConversationRun, recordOriginal, recordResult } from './checkpoints'
import { collectWorkingTreeChanges } from './workingTree'

let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}
const maybe = gitOk ? it : it.skip
// Windows can't name a file with ':' or '*', so a pathspec-shaped file name can't
// exist there to be reverted.
const maybeWithPosixNames = process.platform === 'win32' ? it.skip : maybe
const TIMEOUT = 30_000

const dirs: string[] = []
afterEach(async () => {
  await flushCheckpoints()
  clearCheckpoints()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(d)
  return d
}

const git = (repo: string, ...args: string[]): void => {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
}

function repo(): string {
  const r = tmp('chg-')
  git(r, '-c', 'init.defaultBranch=main', 'init')
  git(r, 'config', 'user.email', 't@t.t')
  git(r, 'config', 'user.name', 'Test')
  writeFileSync(join(r, 'a.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
  writeFileSync(join(r, 'b.txt'), 'keep\n')
  git(r, 'add', '.')
  git(r, 'commit', '-qm', 'init')
  return r
}

const deps = (known: string[], active: string[] = []): RevertDeps => ({
  knownWorkspace: (w) => known.includes(w),
  runActive: (id) => active.includes(id)
})

async function treeReq(ws: string, path: string, hunk?: number): Promise<ChangeRevertRequest> {
  const c = await collectWorkingTreeChanges(ws)
  const f = c.files.find((x) => x.path === path)
  if (!f) throw new Error(`no ${path}`)
  return { scope: 'tree', workspace: ws, path, signature: fileDiffSignature(f), ...(hunk !== undefined ? { hunk } : {}) }
}

describe('revertChange, working tree', () => {
  maybe(
    'reverts one hunk and leaves the rest',
    async () => {
      const ws = repo()
      const a = join(ws, 'a.txt')
      const edited = readFileSync(a, 'utf8').replace('line 2\n', 'two\n').replace('line 18\n', 'eighteen\n')
      writeFileSync(a, edited)
      const req = await treeReq(ws, 'a.txt', 1)
      expect(await revertChange(req, deps([ws]))).toEqual({ ok: true })
      expect(readFileSync(a, 'utf8')).toBe(edited.replace('eighteen\n', 'line 18\n'))
    },
    TIMEOUT
  )

  maybe(
    'discards a whole edited file, a deleted file, and deletes an untracked one',
    async () => {
      const ws = repo()
      writeFileSync(join(ws, 'a.txt'), 'changed\n')
      rmSync(join(ws, 'b.txt'))
      writeFileSync(join(ws, 'new.txt'), 'new\n')
      for (const p of ['a.txt', 'b.txt', 'new.txt']) {
        expect(await revertChange(await treeReq(ws, p), deps([ws]))).toEqual({ ok: true })
      }
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toMatch(/^line 1\n/)
      expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('keep\n')
      expect(existsSync(join(ws, 'new.txt'))).toBe(false)
      expect((await collectWorkingTreeChanges(ws)).files).toEqual([])
    },
    TIMEOUT
  )

  maybeWithPosixNames(
    'unstages and deletes a newly added file, treating pathspec magic as a plain name',
    async () => {
      const ws = repo()
      const odd = ':(glob)*.txt'
      writeFileSync(join(ws, odd), 'x\n')
      git(ws, 'add', '--', `:(literal)${odd}`)
      expect(await revertChange(await treeReq(ws, odd), deps([ws]))).toEqual({ ok: true })
      expect(existsSync(join(ws, odd))).toBe(false)
      // The glob did not match (and so did not touch) the committed files.
      expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('keep\n')
      expect((await collectWorkingTreeChanges(ws)).files).toEqual([])
    },
    TIMEOUT
  )

  maybe(
    'refuses when the file changed since the view loaded it',
    async () => {
      const ws = repo()
      writeFileSync(join(ws, 'a.txt'), 'one\n')
      const req = await treeReq(ws, 'a.txt')
      writeFileSync(join(ws, 'a.txt'), 'two\n')
      const res = await revertChange(req, deps([ws]))
      expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/changed since/) })
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('two\n')
    },
    TIMEOUT
  )

  maybe(
    'refuses an unknown folder, a path git did not list, and a run in progress',
    async () => {
      const ws = repo()
      writeFileSync(join(ws, 'a.txt'), 'one\n')
      const req = await treeReq(ws, 'a.txt')
      expect(await revertChange(req, deps([]))).toMatchObject({ ok: false, error: 'Unknown project folder.' })
      expect(await revertChange({ ...req, path: '../outside.txt' }, deps([ws]))).toMatchObject({ ok: false })
      expect(await revertChange({ ...req, conversationId: 'c1' }, deps([ws], ['c1']))).toMatchObject({
        ok: false,
        error: expect.stringMatching(/current run/)
      })
      expect(await revertChange({ ...req, hunk: -1 }, deps([ws]))).toMatchObject({ ok: false })
      expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('one\n')
    },
    TIMEOUT
  )

  maybe(
    'never deletes through a symlink: removing an untracked link leaves its target',
    async () => {
      const ws = repo()
      const outside = tmp('chg-out-')
      writeFileSync(join(outside, 'secret.txt'), 'keep me\n')
      symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'))
      const c = await collectWorkingTreeChanges(ws)
      const f = c.files.find((x) => x.path === 'link.txt')
      if (f) {
        await revertChange({ scope: 'tree', workspace: ws, path: 'link.txt', signature: fileDiffSignature(f) }, deps([ws]))
      }
      expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('keep me\n')
    },
    TIMEOUT
  )
})

describe('chat and turn scopes', () => {
  async function twoTurns(): Promise<string> {
    const ws = tmp('chg-cp-')
    const f = join(ws, 'f.txt')
    writeFileSync(f, 'v0\n')
    noteConversationRun('conv', 'run-1')
    await recordOriginal('run-1', [ws], 'f.txt')
    writeFileSync(f, 'v1\n')
    await recordResult('run-1', [ws], 'f.txt')
    noteConversationRun('conv', 'run-2')
    await recordOriginal('run-2', [ws], 'f.txt')
    await recordOriginal('run-2', [ws], 'g.txt')
    writeFileSync(f, 'v2\n')
    writeFileSync(join(ws, 'g.txt'), 'new\n')
    await recordResult('run-2', [ws], 'f.txt')
    await recordResult('run-2', [ws], 'g.txt')
    return ws
  }

  it('diffs the latest turn against its own start, and the chat against its first', async () => {
    await twoTurns()
    const turn = await collectChatChanges('conv', 'turn')
    const f = turn.files.find((x) => x.path === 'f.txt')!
    expect(f.hunks[0].lines).toEqual([
      { type: 'del', text: 'v1' },
      { type: 'add', text: 'v2' }
    ])
    expect(turn.files.find((x) => x.path === 'g.txt')?.status).toBe('added')
    const chat = await collectChatChanges('conv', 'chat')
    expect(chat.files.find((x) => x.path === 'f.txt')!.hunks[0].lines[0]).toEqual({ type: 'del', text: 'v0' })
    expect(chat).toMatchObject({ added: 2, removed: 1, unavailable: 0 })
    expect(await collectChatChanges('other', 'chat')).toMatchObject({ files: [] })
  })

  it('puts a file back as it was before the chat, or deletes one the chat created', async () => {
    const ws = await twoTurns()
    const chat = await collectChatChanges('conv', 'chat')
    for (const file of chat.files) {
      const res = await revertChange(
        { scope: 'chat', workspace: ws, conversationId: 'conv', path: file.path, signature: fileDiffSignature(file) },
        deps([])
      )
      expect(res).toEqual({ ok: true })
    }
    expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('v0\n')
    expect(existsSync(join(ws, 'g.txt'))).toBe(false)
    expect((await collectChatChanges('conv', 'chat')).files).toEqual([])
  })

  it('reverts a turn hunk, and refuses while the chat runs or once the file moved on', async () => {
    const ws = await twoTurns()
    const file = (await collectChatChanges('conv', 'turn')).files.find((x) => x.path === 'f.txt')!
    const req: ChangeRevertRequest = {
      scope: 'turn',
      workspace: ws,
      conversationId: 'conv',
      path: 'f.txt',
      signature: fileDiffSignature(file),
      hunk: 0
    }
    expect(await revertChange(req, deps([], ['conv']))).toMatchObject({ ok: false })
    expect(await revertChange({ ...req, conversationId: undefined }, deps([]))).toMatchObject({ ok: false })
    expect(await revertChange(req, deps([]))).toEqual({ ok: true })
    expect(readFileSync(join(ws, 'f.txt'), 'utf8')).toBe('v1\n')
    // The same request again: the diff it names is gone.
    expect(await revertChange(req, deps([]))).toMatchObject({ ok: false, error: expect.stringMatching(/changed since/) })
  })
})
