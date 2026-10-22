import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkMerge, findReverts, landingBase } from './merge-revert-guard.mjs'

// findReverts(base, result, deps) is pure given injected git/exists lookups, so we drive
// it with synthetic numstat + tree membership instead of a real repo.
function harness({
  numstat,
  existsOnBase = new Set(),
  existsInResult = new Set(),
  recent = new Set(),
  dependencyUpdate = false
}) {
  return findReverts('BASE', 'RESULT', {
    git: () => numstat,
    exists: (f) => existsOnBase.has(f),
    existsInResult: (_r, f) => existsInResult.has(f),
    recent,
    dependencyUpdate
  })
}

describe('merge-revert-guard findReverts', () => {
  it('flags a deleted file that still exists on main (Rule 1 — the #551 shape)', () => {
    const { deletions, contentReverts } = harness({
      numstat: '0\t250\tsrc/main/schedulerService.ts',
      existsOnBase: new Set(['src/main/schedulerService.ts']),
      existsInResult: new Set() // absent in the merge result → deleted
    })
    expect(deletions).toEqual([{ file: 'src/main/schedulerService.ts', removed: 250 }])
    expect(contentReverts).toEqual([])
  })

  it('does NOT flag a file the PR legitimately renamed/kept (still present in the result)', () => {
    const { deletions } = harness({
      numstat: '10\t250\tsrc/main/foo.ts',
      existsOnBase: new Set(['src/main/foo.ts']),
      existsInResult: new Set(['src/main/foo.ts']) // still there → not a deletion
    })
    expect(deletions).toEqual([])
  })

  it('does NOT flag deleting a file that never existed on main (pure add-then-remove within the PR)', () => {
    const { deletions } = harness({
      numstat: '0\t5\ttmp/scratch.ts',
      existsOnBase: new Set(), // not on main
      existsInResult: new Set()
    })
    expect(deletions).toEqual([])
  })

  it('flags a large content revert of a recently-touched file (Rule 2)', () => {
    const { contentReverts } = harness({
      numstat: '5\t190\tsrc/main/agent/loop.ts',
      existsOnBase: new Set(['src/main/agent/loop.ts']),
      existsInResult: new Set(['src/main/agent/loop.ts']),
      recent: new Set(['src/main/agent/loop.ts']) // main touched it recently
    })
    expect(contentReverts).toEqual([{ file: 'src/main/agent/loop.ts', net: 185 }])
  })

  it('does NOT flag a large removal from a file main has NOT touched recently (ordinary refactor)', () => {
    const { contentReverts } = harness({
      numstat: '5\t190\tsrc/main/agent/old.ts',
      existsOnBase: new Set(['src/main/agent/old.ts']),
      existsInResult: new Set(['src/main/agent/old.ts']),
      recent: new Set() // untouched recently → not a clobber signal
    })
    expect(contentReverts).toEqual([])
  })

  it('does NOT flag a small trim of a recently-touched file (below the line threshold)', () => {
    const { contentReverts } = harness({
      numstat: '2\t12\tsrc/main/agent/loop.ts',
      existsOnBase: new Set(['src/main/agent/loop.ts']),
      existsInResult: new Set(['src/main/agent/loop.ts']),
      recent: new Set(['src/main/agent/loop.ts'])
    })
    expect(contentReverts).toEqual([])
  })

  it('skips binary files (numstat "-")', () => {
    const { deletions, contentReverts } = harness({
      numstat: '-\t-\tbuild/icon.png',
      existsOnBase: new Set(['build/icon.png'])
    })
    expect(deletions).toEqual([])
    expect(contentReverts).toEqual([])
  })

  it('a clean feature merge (only additions) trips nothing', () => {
    const { deletions, contentReverts } = harness({
      numstat: '120\t0\tsrc/main/agent/feature.ts\n40\t3\tsrc/main/agent/loop.ts',
      existsOnBase: new Set(['src/main/agent/loop.ts']),
      existsInResult: new Set(['src/main/agent/loop.ts', 'src/main/agent/feature.ts']),
      recent: new Set(['src/main/agent/loop.ts'])
    })
    expect(deletions).toEqual([])
    expect(contentReverts).toEqual([])
  })

  describe('dependency updates (DEPENDENCY_UPDATE=1, Dependabot PRs)', () => {
    // The shape of a Dependabot bump that prunes transitive packages (PR #275).
    const pruning = {
      numstat: '98\t345\tpackage-lock.json\n878\t2669\tTHIRD-PARTY-NOTICES.md\n1\t1\tpackage.json',
      existsOnBase: new Set(['package-lock.json', 'THIRD-PARTY-NOTICES.md', 'package.json']),
      existsInResult: new Set(['package-lock.json', 'THIRD-PARTY-NOTICES.md', 'package.json']),
      recent: new Set(['package-lock.json', 'THIRD-PARTY-NOTICES.md', 'package.json'])
    }

    it('flags a pruned lockfile and notices on an ordinary PR', () => {
      expect(harness(pruning).contentReverts).toEqual([
        { file: 'package-lock.json', net: 247 },
        { file: 'THIRD-PARTY-NOTICES.md', net: 1791 }
      ])
    })

    it('does NOT flag them on a dependency update', () => {
      expect(harness({ ...pruning, dependencyUpdate: true })).toEqual({ deletions: [], contentReverts: [] })
    })

    it('still flags a content revert of any other file on a dependency update', () => {
      const { contentReverts } = harness({
        numstat: '0\t120\tsrc/main/agent/loop.ts\n10\t300\tpackage-lock.json',
        existsOnBase: new Set(['src/main/agent/loop.ts', 'package-lock.json']),
        existsInResult: new Set(['src/main/agent/loop.ts', 'package-lock.json']),
        recent: new Set(['src/main/agent/loop.ts', 'package-lock.json']),
        dependencyUpdate: true
      })
      expect(contentReverts).toEqual([{ file: 'src/main/agent/loop.ts', net: 120 }])
    })

    it('still flags deleting a generated file on a dependency update (Rule 1)', () => {
      const { deletions } = harness({
        numstat: '0\t900\tTHIRD-PARTY-NOTICES.md',
        existsOnBase: new Set(['THIRD-PARTY-NOTICES.md']),
        existsInResult: new Set(),
        dependencyUpdate: true
      })
      expect(deletions).toEqual([{ file: 'THIRD-PARTY-NOTICES.md', removed: 900 }])
    })
  })
})

describe('merge-revert-guard landingBase', () => {
  it('uses the first parent of a merge commit', () => {
    expect(landingBase('origin/main', ['p1', 'p2'])).toBe('p1')
  })

  it('keeps the given base for a non-merge result or a root commit', () => {
    expect(landingBase('origin/main', ['p1'])).toBe('origin/main')
    expect(landingBase('origin/main', [])).toBe('origin/main')
  })
})

// End to end against a real repository: the CI shape is a PR merge commit built at
// one point, checked against a base that may have moved on since.
describe('merge-revert-guard checkMerge on a real repo', () => {
  let dir
  const g = (...args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@example.com',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@example.com'
      }
    }).trim()
  const write = (file, text) => {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join('\n') + '\n'
  /** A merge commit with the given parents and the tree of `treeOf`, like refs/pull/N/merge. */
  const mergeCommit = (treeOf, ...parents) =>
    g('commit-tree', `${treeOf}^{tree}`, ...parents.flatMap((p) => ['-p', p]), '-m', 'merge')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revert-guard-'))
    g('init', '-q', '-b', 'main')
    write('src/a.ts', lines(50, 'a'))
    g('add', '-A')
    g('commit', '-q', '-m', 'base')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ignores files the base gained after the PR merge was built', () => {
    const base0 = g('rev-parse', 'HEAD')
    g('switch', '-q', '-c', 'pr')
    write('src/pr.ts', 'export const pr = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'pr')
    const pr = g('rev-parse', 'HEAD')
    // GitHub builds refs/pull/N/merge now...
    g('switch', '-q', 'main')
    g('merge', '-q', '--no-ff', '--no-edit', 'pr')
    const merge = g('rev-parse', 'HEAD')
    g('reset', '-q', '--hard', base0)
    // ...then main moves on (another PR lands) before the guard job runs.
    write('src/new-on-main.ts', lines(80, 'new'))
    write('src/a.ts', lines(10, 'a'))
    g('add', '-A')
    g('commit', '-q', '-m', 'another PR lands')
    const movedMain = g('rev-parse', 'HEAD')

    // Diffing against the moved tip reports main's new file as deleted (the old bug)...
    const stale = findReverts(movedMain, merge, { cwd: dir })
    expect(stale.deletions.map((d) => d.file)).toContain('src/new-on-main.ts')
    // ...but the merge's own base shows only the PR's change.
    const r = checkMerge(movedMain, merge, { cwd: dir })
    expect(r.compareTo).toBe(base0)
    expect(r.deletions).toEqual([])
    expect(r.contentReverts).toEqual([])
    expect(pr).not.toBe(merge)
  })

  it('still flags the #551 shape: a stale tree committed on top of current main', () => {
    const base0 = g('rev-parse', 'HEAD')
    // Main gains a feature while a branch is open.
    write('src/feature.ts', lines(60, 'feature'))
    write('src/a.ts', lines(50, 'a') + lines(40, 'more'))
    g('add', '-A')
    g('commit', '-q', '-m', 'feature lands')
    const main = g('rev-parse', 'HEAD')
    // The branch is "finalized" as the OLD tree with current main as its parent
    // (git reset --soft origin/main && git commit), so the feature reads as removed.
    const staleTree = g('rev-parse', `${base0}^{tree}`)
    const stale = g('commit-tree', staleTree, '-p', main, '-m', 'finalize on a stale tree')
    const merge = mergeCommit(stale, main, stale)

    const r = checkMerge(main, merge, { cwd: dir })
    expect(r.compareTo).toBe(main)
    expect(r.deletions).toEqual([{ file: 'src/feature.ts', removed: 60 }])
    expect(r.contentReverts).toEqual([{ file: 'src/a.ts', net: 40 }])
  })

  it('compares against the given base when the result is not a merge', () => {
    write('src/b.ts', 'b\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'b')
    const head = g('rev-parse', 'HEAD')
    const r = checkMerge('main', head, { cwd: dir })
    expect(r.compareTo).toBe('main')
    expect(r.deletions).toEqual([])
  })
})
