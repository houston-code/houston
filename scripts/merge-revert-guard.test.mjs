import { describe, it, expect } from 'vitest'
import { findReverts } from './merge-revert-guard.mjs'

// findReverts(base, result, deps) is pure given injected git/exists lookups, so we drive
// it with synthetic numstat + tree membership instead of a real repo.
function harness({ numstat, existsOnBase = new Set(), existsInResult = new Set(), recent = new Set() }) {
  return findReverts('BASE', 'RESULT', {
    git: () => numstat,
    exists: (f) => existsOnBase.has(f),
    existsInResult: (_r, f) => existsInResult.has(f),
    recent
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
})
