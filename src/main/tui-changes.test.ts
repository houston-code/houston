import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileDiffSignature } from '@shared/changes'
import { numberDiff } from '@shared/diff'
import type { FileDiff } from '@shared/workingTree'
import { makePainter } from './tui'
import {
  fileDiffLines,
  findChangedFile,
  parseChangesArgs,
  renderChangeSummary,
  renderFileDiff,
  runChangesCommand,
  type ChangeSet,
  type ChangesContext,
  type ChangesDeps
} from './tui-changes'
import { revertChange } from './agent/changes'
import { collectWorkingTreeChanges } from './agent/workingTree'

const paint = makePainter(false)

const file = (over: Partial<FileDiff> = {}): FileDiff => ({
  path: 'src/a.ts',
  status: 'modified',
  hunks: [
    {
      header: '@@ -10,3 +10,3 @@',
      lines: [
        { type: 'ctx', text: 'one' },
        { type: 'del', text: 'const x = 1' },
        { type: 'add', text: 'const x = 2' },
        { type: 'ctx', text: 'three' }
      ]
    }
  ],
  added: 1,
  removed: 1,
  binary: false,
  ...over
})

const set = (files: FileDiff[], over: Partial<ChangeSet> = {}): ChangeSet => ({
  isRepo: true,
  branch: 'main',
  files,
  added: files.reduce((n, f) => n + f.added, 0),
  removed: files.reduce((n, f) => n + f.removed, 0),
  ...over
})

function ctx(deps: ChangesDeps | undefined, answers: Array<string | null> = [], conversationId: string | null = 'c1') {
  const out: string[] = []
  const asked: string[] = []
  const c: ChangesContext = {
    deps,
    conversationId,
    out: (t) => out.push(t),
    ask: async (p) => (asked.push(p), answers.shift() ?? null),
    paint
  }
  return { c, out, asked, text: () => out.join('') }
}

describe('parseChangesArgs', () => {
  it('reads a scope, revert, and a path in either order', () => {
    expect(parseChangesArgs('')).toEqual({ op: 'summary', scope: 'tree' })
    expect(parseChangesArgs('turn')).toEqual({ op: 'summary', scope: 'turn' })
    expect(parseChangesArgs('CHAT')).toEqual({ op: 'summary', scope: 'chat' })
    expect(parseChangesArgs('src/a.ts')).toEqual({ op: 'show', scope: 'tree', path: 'src/a.ts' })
    expect(parseChangesArgs('chat src/a.ts')).toEqual({ op: 'show', scope: 'chat', path: 'src/a.ts' })
    expect(parseChangesArgs('revert src/a.ts')).toEqual({ op: 'revert', scope: 'tree', path: 'src/a.ts' })
    expect(parseChangesArgs('turn revert src/a.ts')).toEqual({ op: 'revert', scope: 'turn', path: 'src/a.ts' })
    expect(parseChangesArgs('revert turn src/a.ts')).toEqual({ op: 'revert', scope: 'turn', path: 'src/a.ts' })
    expect(parseChangesArgs('revert')).toEqual({ op: 'revert', scope: 'tree', path: '' })
  })

  it('reads a second scope word as the path', () => {
    expect(parseChangesArgs('turn chat')).toEqual({ op: 'show', scope: 'turn', path: 'chat' })
    expect(parseChangesArgs('./turn')).toEqual({ op: 'show', scope: 'tree', path: './turn' })
    // An inherited name is not a scope.
    expect(parseChangesArgs('constructor')).toEqual({ op: 'show', scope: 'tree', path: 'constructor' })
  })
})

describe('fileDiffLines', () => {
  it('numbers the gutter from the hunk header, not from 1', () => {
    const lines = numberDiff(fileDiffLines(file()))
    expect(lines[0]).toMatchObject({ type: 'skip', count: 9 })
    expect(lines[1]).toMatchObject({ type: 'ctx', oldNo: 10, newNo: 10 })
    expect(lines[2]).toMatchObject({ type: 'del', oldNo: 11 })
    expect(lines[3]).toMatchObject({ type: 'add', newNo: 11 })
  })

  it('folds the gap between hunks and handles a new file', () => {
    const two = file({
      hunks: [
        { header: '@@ -1,2 +1,2 @@', lines: [{ type: 'del', text: 'a' }, { type: 'add', text: 'A' }, { type: 'ctx', text: 'b' }] },
        { header: '@@ -20,1 +20,1 @@', lines: [{ type: 'del', text: 't' }, { type: 'add', text: 'T' }] }
      ]
    })
    const n = numberDiff(fileDiffLines(two))
    expect(n.find((l) => l.type === 'skip')).toMatchObject({ count: 17 })
    expect(n.at(-2)).toMatchObject({ type: 'del', oldNo: 20 })
    const added = file({ status: 'untracked', hunks: [{ header: '@@ -0,0 +1,2 @@', lines: [{ type: 'add', text: 'x' }, { type: 'add', text: 'y' }] }] })
    expect(fileDiffLines(added).some((l) => l.type === 'skip')).toBe(false)
  })
})

describe('renderFileDiff', () => {
  it('marks a replacement with numbers and caps a long diff', () => {
    const out = renderFileDiff(file(), paint)
    expect(out).toContain('src/a.ts')
    expect(out).toContain('11 - const x = 1')
    expect(out).toContain('11 + const x = 2')
    const big = file({
      hunks: [{ header: '@@ -0,0 +1,50 @@', lines: Array.from({ length: 50 }, (_, i) => ({ type: 'add' as const, text: `l${i}` })) }]
    })
    expect(renderFileDiff(big, paint, { maxLines: 10 })).toContain('40 more changed lines')
  })

  it('shows a note instead of hunks, and never passes escapes through', () => {
    expect(renderFileDiff(file({ binary: true, hunks: [], note: 'Binary file' }), paint)).toContain('Binary file')
    expect(renderFileDiff(file({ path: 'x\u001b[2Jy.ts' }), paint)).not.toContain('\u001b[2J')
  })
})

describe('findChangedFile', () => {
  const files = [file({ path: 'src/a.ts' }), file({ path: 'lib/a.ts' }), file({ path: 'README.md' })]
  it('matches exactly, then by a unique trailing path', () => {
    expect(findChangedFile(files, './README.md')).toEqual({ file: files[2] })
    expect(findChangedFile(files, 'md')).toBeNull()
    expect(findChangedFile(files, 'src/a.ts')).toEqual({ file: files[0] })
    expect(findChangedFile(files, 'a.ts')).toEqual({ ambiguous: [files[0], files[1]] })
    expect(findChangedFile(files, 'nope.ts')).toBeNull()
  })
})

describe('renderChangeSummary', () => {
  it('words each scope and notes cleared snapshots', () => {
    expect(renderChangeSummary('turn', set([file()]), paint)).toContain("Changed by this chat's latest turn:")
    expect(renderChangeSummary('chat', set([], { unavailable: 2 }), paint)).toContain('2 earlier turns changed files')
    expect(renderChangeSummary('tree', set([], { isRepo: false }), paint)).toContain('not a git repository')
    expect(renderChangeSummary('chat', set([file()]), paint, { hint: true })).toContain('/changes chat revert <path>')
  })
})

describe('runChangesCommand', () => {
  const fakeDeps = (s: ChangeSet, reverts: unknown[] = []): ChangesDeps => ({
    load: async () => s,
    revert: async (r) => (reverts.push(r), { ok: true })
  })

  it('needs a saved chat for the chat scopes', async () => {
    const loads: string[] = []
    const t = ctx({ load: async (sc) => (loads.push(sc), set([])), revert: async () => ({ ok: true }) }, [], null)
    await runChangesCommand({ op: 'summary', scope: 'turn' }, t.c)
    expect(loads).toEqual([])
    expect(t.text()).toContain('no turns yet')
  })

  it('says when the file has no changes, or names the candidates', async () => {
    const t = ctx(fakeDeps(set([file({ path: 'src/a.ts' }), file({ path: 'lib/a.ts' })])))
    await runChangesCommand({ op: 'show', scope: 'tree', path: 'b.ts' }, t.c)
    expect(t.text()).toContain('b.ts has no changes in the working tree')
    await runChangesCommand({ op: 'revert', scope: 'tree', path: 'a.ts' }, t.c)
    expect(t.text()).toContain('matches more than one changed file')
    expect(t.asked).toEqual([])
  })

  it('declining a revert, or ending input, reverts nothing', async () => {
    for (const answer of ['n', 'no', '', 'yy', null]) {
      const reverts: unknown[] = []
      const t = ctx(fakeDeps(set([file()]), reverts), [answer])
      await runChangesCommand({ op: 'revert', scope: 'turn', path: 'src/a.ts' }, t.c)
      expect(reverts).toEqual([])
      expect(t.asked[0]).toContain('Put src/a.ts back as it was before this turn? [y/N]')
      expect(t.text()).toContain('nothing was reverted')
      // The diff being discarded is on screen before the question.
      expect(t.text()).toContain('const x = 2')
    }
  })

  it('a "y" reverts with the signature of the diff it showed', async () => {
    const reverts: Array<Record<string, unknown>> = []
    const f = file()
    const t = ctx(fakeDeps(set([f]), reverts), ['y'])
    await runChangesCommand({ op: 'revert', scope: 'chat', path: 'src/a.ts' }, t.c)
    expect(reverts).toEqual([{ scope: 'chat', conversationId: 'c1', path: 'src/a.ts', signature: fileDiffSignature(f) }])
    expect(t.text()).toContain('reverted src/a.ts')
  })

  it('reports a refused revert', async () => {
    const t = ctx({ load: async () => set([file()]), revert: async () => ({ ok: false, error: 'Wait for the current run to finish.' }) }, ['yes'])
    await runChangesCommand({ op: 'revert', scope: 'tree', path: 'src/a.ts' }, t.c)
    expect(t.text()).toContain('Wait for the current run to finish.')
    expect(t.text()).not.toContain('reverted src/a.ts')
  })
})

// End to end with the desktop's own loader and revert, on a real repository.
let gitOk = true
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
} catch {
  gitOk = false
}
const maybe = gitOk ? it : it.skip

describe('/changes revert on a real repository', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const git = (r: string, ...args: string[]): void => {
    execFileSync('git', ['-C', r, ...args], { stdio: 'ignore' })
  }
  function repo(): string {
    const r = realpathSync(mkdtempSync(join(tmpdir(), 'tui-chg-')))
    dirs.push(r)
    git(r, '-c', 'init.defaultBranch=main', 'init')
    git(r, 'config', 'user.email', 't@t.t')
    git(r, 'config', 'user.name', 'Test')
    writeFileSync(join(r, 'a.txt'), 'one\ntwo\n')
    git(r, 'add', '.')
    git(r, 'commit', '-qm', 'init')
    writeFileSync(join(r, 'a.txt'), 'one\nTWO\n')
    writeFileSync(join(r, 'new.txt'), 'fresh\n')
    return r
  }
  const realDeps = (root: string): ChangesDeps => ({
    load: async () => collectWorkingTreeChanges(root),
    revert: (req) => revertChange({ ...req, workspace: root }, { runActive: () => false, knownWorkspace: (w) => w === root })
  })

  maybe('a declined revert leaves the edit and the untracked file in place', async () => {
    const r = repo()
    for (const path of ['a.txt', 'new.txt']) {
      const t = ctx(realDeps(r), ['n'])
      await runChangesCommand({ op: 'revert', scope: 'tree', path }, t.c)
    }
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('one\nTWO\n')
    expect(existsSync(join(r, 'new.txt'))).toBe(true)
  }, 30_000)

  maybe('a confirmed revert discards only the named file', async () => {
    const r = repo()
    const t = ctx(realDeps(r), ['y'])
    await runChangesCommand({ op: 'revert', scope: 'tree', path: 'a.txt' }, t.c)
    expect(t.text()).toContain('reverted a.txt')
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('one\ntwo\n')
    expect(existsSync(join(r, 'new.txt'))).toBe(true)
  }, 30_000)

  maybe('a file that changed after it was shown is refused, not discarded', async () => {
    const r = repo()
    const base = realDeps(r)
    const t = ctx(base, [])
    // The question is answered after the file changes again.
    t.c.ask = async () => {
      writeFileSync(join(r, 'a.txt'), 'one\nTWO\nthree\n')
      return 'y'
    }
    await runChangesCommand({ op: 'revert', scope: 'tree', path: 'a.txt' }, t.c)
    expect(t.text()).toContain('changed since the list was loaded')
    expect(readFileSync(join(r, 'a.txt'), 'utf8')).toBe('one\nTWO\nthree\n')
  }, 30_000)
})
