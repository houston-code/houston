import { describe, it, expect } from 'vitest'
import type { SubAgentOptions } from './subagent'
import {
  chunkReviewInput,
  formatReviewInput,
  isSafeReviewPath,
  parseFindings,
  reviewWorkspaceChanges,
  runReview,
  splitDiffByFile,
  verifierSystem,
  type RunReviewOptions
} from './review'
import type { GitExec } from './git'

/** A fake subagent runner that records its calls and replies via a handler. */
function fakeAgent(handler: (opts: SubAgentOptions) => string): {
  fn: (opts: SubAgentOptions) => Promise<string>
  calls: SubAgentOptions[]
} {
  const calls: SubAgentOptions[] = []
  return {
    calls,
    fn: async (opts: SubAgentOptions) => {
      calls.push(opts)
      return handler(opts)
    }
  }
}

const isVerifier = (o: SubAgentOptions): boolean =>
  (o.systemOverride ?? '').includes('skeptical verification')
const isSkeptic = (o: SubAgentOptions): boolean =>
  (o.systemOverride ?? '').includes('checking ONE candidate finding')
const dimensionOf = (o: SubAgentOptions): string | undefined =>
  ['CORRECTNESS', 'SECURITY', 'QUALITY'].find((d) => (o.systemOverride ?? '').includes(d))

const base = (over: Partial<RunReviewOptions> = {}): RunReviewOptions => ({
  // The provider/model are never touched when runAgent is injected.
  provider: { streamChat: async function* () {} },
  model: 'm',
  workspace: '/ws',
  diff: 'Diff of changes to tracked files (git diff):\n\n@@ a.ts @@\n+bad code',
  signal: new AbortController().signal,
  ...over
})

describe('formatReviewInput', () => {
  it('combines the tracked diff and untracked file list', () => {
    const out = formatReviewInput({ isRepo: true, diff: '@@ a @@\n+x', untracked: ['new.ts'] })
    expect(out).toContain('git diff')
    expect(out).toContain('+x')
    expect(out).toContain('- new.ts')
  })

  it('omits the diff section when there are only untracked files', () => {
    const out = formatReviewInput({ isRepo: true, diff: '', untracked: ['new.ts'] })
    expect(out).not.toContain('git diff')
    expect(out).toContain('new.ts')
  })

  it('is empty when there is nothing to review', () => {
    expect(formatReviewInput({ isRepo: true, diff: '', untracked: [] })).toBe('')
  })

  it('truncates an oversized diff and says so', () => {
    const out = formatReviewInput({ isRepo: true, diff: 'x'.repeat(60_000), untracked: [] })
    expect(out).toContain('truncated')
  })
})

describe('splitDiffByFile', () => {
  it('splits a unified diff on file boundaries', () => {
    const parts = splitDiffByFile('diff --git a/a.ts b/a.ts\n+x\ndiff --git a/b.ts b/b.ts\n+y')
    expect(parts).toHaveLength(2)
    expect(parts[0]).toContain('a/a.ts')
    expect(parts[1]).toContain('a/b.ts')
  })
})

describe('chunkReviewInput', () => {
  it('returns a single chunk for a small diff', () => {
    const chunks = chunkReviewInput({ isRepo: true, diff: 'diff --git a/a b/a\n+x', untracked: [] })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toContain('git diff')
    expect(chunks[0]).not.toContain('part 1 of')
  })

  it('splits a large diff by file and appends untracked files to the last chunk', () => {
    const fileA = 'diff --git a/a.ts b/a.ts\n@@ @@\n+' + 'a'.repeat(40)
    const fileB = 'diff --git a/b.ts b/b.ts\n@@ @@\n+' + 'b'.repeat(40)
    const chunks = chunkReviewInput({ isRepo: true, diff: `${fileA}\n${fileB}`, untracked: ['n.ts'] }, 30)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toContain('part 1 of 2')
    expect(chunks[1]).toContain('part 2 of 2')
    expect(chunks[1]).toContain('n.ts') // untracked rides on the last chunk
  })

  it('returns [] when there is nothing to review', () => {
    expect(chunkReviewInput({ isRepo: true, diff: '', untracked: [] })).toEqual([])
  })
})

describe('runReview', () => {
  it('reviews each dimension in its own context, then verifies the findings', async () => {
    const { fn, calls } = fakeAgent((o) => {
      if (isVerifier(o)) return '- [high] a.ts:1 — confirmed bug\nConfirmed 1 of 1 candidate findings.'
      return dimensionOf(o) === 'CORRECTNESS'
        ? '- [SEVERITY: high] a.ts:1 — off-by-one'
        : 'No issues found.'
    })
    const out = await runReview(base({ runAgent: fn }))

    // Three reviewers (one per dimension) plus one verifier.
    expect(calls.filter((c) => !isVerifier(c)).map(dimensionOf).sort()).toEqual([
      'CORRECTNESS',
      'QUALITY',
      'SECURITY'
    ])
    const verifierCalls = calls.filter(isVerifier)
    expect(verifierCalls).toHaveLength(1)
    // The verifier is handed the surviving candidate finding.
    expect(verifierCalls[0].prompt).toContain('off-by-one')
    expect(out).toContain('confirmed bug')
    expect(out).toContain('separate context')
    // Findings present → nudge the agent to re-review after fixing them.
    expect(out).toContain('run review_changes again')
  })

  it('does not add the re-review nudge to a clean review', async () => {
    const { fn } = fakeAgent(() => 'No issues found.')
    const out = await runReview(base({ runAgent: fn }))
    expect(out).not.toContain('run review_changes again')
  })

  it('short-circuits without a verifier when every reviewer is clean', async () => {
    const { fn, calls } = fakeAgent(() => 'No issues found.')
    const out = await runReview(base({ runAgent: fn }))
    expect(calls).toHaveLength(3) // no verifier call
    expect(calls.some(isVerifier)).toBe(false)
    expect(out.toLowerCase()).toContain('no issues found across')
  })

  it('reports nothing to review for an empty diff', async () => {
    const { fn, calls } = fakeAgent(() => 'unused')
    const out = await runReview(base({ diff: '   ', runAgent: fn }))
    expect(calls).toHaveLength(0)
    expect(out).toBe('No changes to review.')
  })

  it('reviews every chunk per dimension and merges findings across chunks', async () => {
    const { fn, calls } = fakeAgent((o) => {
      if (isVerifier(o)) return '- [high] b.ts:1 — confirmed\nConfirmed 1 of 1 candidate findings.'
      // A finding lives only in chunk B; chunk A and other dimensions are clean.
      return dimensionOf(o) === 'CORRECTNESS' && o.prompt.includes('CHUNK_B')
        ? '- [SEVERITY: high] b.ts:1 — chunk-b bug'
        : 'No issues found.'
    })
    const out = await runReview(base({ runAgent: fn, chunks: ['CHUNK_A diff', 'CHUNK_B diff'] }))
    // 3 dimensions × 2 chunks = 6 reviewer calls (skeptics not used at normal effort).
    expect(calls.filter((c) => !isVerifier(c))).toHaveLength(6)
    // The chunk-B finding is merged into the candidates handed to the verifier.
    expect(calls.find(isVerifier)!.prompt).toContain('chunk-b bug')
    expect(out).toContain('confirmed')
  })

  it('surfaces a reviewer that failed as a note', async () => {
    const { fn } = fakeAgent((o) => {
      if (isVerifier(o)) return '- [high] a.ts:1 — confirmed\nConfirmed 1 of 1 candidate findings.'
      if (dimensionOf(o) === 'CORRECTNESS') return '- [SEVERITY: high] a.ts:1 — bug'
      if (dimensionOf(o) === 'SECURITY') return '[subagent error: boom]'
      return 'No issues found.'
    })
    const out = await runReview(base({ runAgent: fn }))
    expect(out).toContain('security review could not complete')
    expect(out).toContain('boom')
    expect(out).toContain('confirmed')
  })

  it('honours a custom dimension list', async () => {
    const { fn, calls } = fakeAgent(() => 'No issues found.')
    await runReview(base({ runAgent: fn, dimensions: ['correctness'] }))
    expect(calls).toHaveLength(1)
    expect(dimensionOf(calls[0])).toBe('CORRECTNESS')
  })

  it('returns an aborted note when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fn, calls } = fakeAgent(() => 'unused')
    const out = await runReview(base({ runAgent: fn, signal: ac.signal }))
    expect(calls).toHaveLength(0)
    expect(out).toContain('aborted')
  })
})

describe('verifierSystem', () => {
  it('instructs the verifier to merge duplicate findings', () => {
    expect(verifierSystem().toLowerCase()).toContain('merge them into a single finding')
  })
})

describe('parseFindings', () => {
  it('splits bullets into per-finding blocks tagged by dimension and severity', () => {
    const text =
      '### correctness findings\n- [SEVERITY: high] a.ts:1 — x\n  why it matters\n- [low] b.ts:2 — y\n\n### security findings\n- [critical] c.ts:3 — z'
    const f = parseFindings(text)
    expect(f).toHaveLength(3)
    expect(f[0]).toMatchObject({ dimension: 'correctness', severity: 'high' })
    expect(f[0].text).toContain('why it matters') // continuation line captured
    expect(f[1].severity).toBe('low')
    expect(f[2]).toMatchObject({ dimension: 'security', severity: 'critical' })
  })

  it('returns [] when there are no bullet findings to parse', () => {
    expect(parseFindings('### correctness findings\njust prose, no bullets')).toEqual([])
  })
})

describe('runReview high effort', () => {
  it('verifies each finding by a vote of skeptics and keeps the confirmed ones', async () => {
    const correctness =
      '- [SEVERITY: high] a.ts:1 — bug one\n  Why: real\n- [SEVERITY: low] b.ts:2 — nit two\n  Why: cosmetic'
    const { fn, calls } = fakeAgent((o) => {
      if (isSkeptic(o)) return o.prompt.includes('bug one') ? 'CONFIRMED a real bug' : 'REJECTED not real'
      return dimensionOf(o) === 'CORRECTNESS' ? correctness : 'No issues found.'
    })
    const out = await runReview(base({ runAgent: fn, effort: 'high' }))

    // Two findings × 3 skeptics each; the single-verifier path is not used.
    expect(calls.filter(isSkeptic)).toHaveLength(6)
    expect(calls.some(isVerifier)).toBe(false)
    expect(out).toContain('bug one')
    expect(out).not.toContain('nit two')
    expect(out).toContain('Confirmed 1 of 2 candidate findings')
    expect(out).toContain('run review_changes again')
  })

  it('falls back to the single verifier when nothing parses into findings', async () => {
    const { fn, calls } = fakeAgent((o) => {
      if (isVerifier(o)) return 'No confirmed issues.'
      return dimensionOf(o) === 'SECURITY' ? 'Something feels off but I cannot pin it down.' : 'No issues found.'
    })
    await runReview(base({ runAgent: fn, effort: 'high' }))
    expect(calls.filter(isSkeptic)).toHaveLength(0)
    expect(calls.filter(isVerifier)).toHaveLength(1)
  })
})

describe('isSafeReviewPath', () => {
  it('accepts project-relative paths', () => {
    for (const p of ['src', 'src/api/index.ts', 'a/b/c.tsx', 'README.md']) {
      expect(isSafeReviewPath(p)).toBe(true)
    }
  })

  it('rejects absolute paths, parent-climbing, and empties', () => {
    for (const p of ['/etc/passwd', '../secrets', 'a/../../b', '..', '', '   ', 'C:\\win']) {
      expect(isSafeReviewPath(p)).toBe(false)
    }
  })
})

describe('reviewWorkspaceChanges', () => {
  const gitExecOf =
    (map: Record<string, string | Error>): GitExec =>
    async (args) => {
      const key = `${args[0]} ${args[1] ?? ''}`.trim()
      const v = map[key] ?? map[args[0]]
      if (v instanceof Error) throw v
      return v ?? ''
    }

  it('refuses when the workspace is not a git repo', async () => {
    const { fn, calls } = fakeAgent(() => 'unused')
    const out = await reviewWorkspaceChanges({
      provider: base().provider,
      model: 'm',
      workspace: '/ws',
      signal: new AbortController().signal,
      gitExec: gitExecOf({ 'rev-parse': new Error('not a git repository') }),
      runAgent: fn
    })
    expect(out).toContain('not a git repository')
    expect(calls).toHaveLength(0)
  })

  it('says there is nothing to review when the tree is clean', async () => {
    const { fn, calls } = fakeAgent(() => 'unused')
    const out = await reviewWorkspaceChanges({
      provider: base().provider,
      model: 'm',
      workspace: '/ws',
      base: 'main',
      signal: new AbortController().signal,
      gitExec: gitExecOf({ 'rev-parse': 'true', diff: '', 'ls-files': '' }),
      runAgent: fn
    })
    expect(out).toContain('No uncommitted changes')
    expect(out).toContain('against main')
    expect(calls).toHaveLength(0)
  })

  it('rejects an option-like base ref before touching git', async () => {
    let execCalled = false
    const out = await reviewWorkspaceChanges({
      provider: base().provider,
      model: 'm',
      workspace: '/ws',
      base: '--output=/tmp/pwn',
      signal: new AbortController().signal,
      gitExec: async () => {
        execCalled = true
        return ''
      },
      runAgent: fakeAgent(() => 'unused').fn
    })
    expect(out).toContain('Invalid base ref')
    expect(execCalled).toBe(false)
  })

  it('runs the review when there are changes', async () => {
    const { fn, calls } = fakeAgent(() => 'No issues found.')
    const out = await reviewWorkspaceChanges({
      provider: base().provider,
      model: 'm',
      workspace: '/ws',
      signal: new AbortController().signal,
      gitExec: gitExecOf({ 'rev-parse': 'true', diff: '@@ a.ts @@\n+x', 'ls-files': '' }),
      runAgent: fn
    })
    expect(calls.length).toBeGreaterThan(0)
    expect(out.toLowerCase()).toContain('no issues found across')
  })

  it('rejects an unsafe review path before touching git', async () => {
    let execCalled = false
    const out = await reviewWorkspaceChanges({
      provider: base().provider,
      model: 'm',
      workspace: '/ws',
      paths: ['../etc/passwd'],
      signal: new AbortController().signal,
      gitExec: async () => {
        execCalled = true
        return ''
      },
      runAgent: fakeAgent(() => 'unused').fn
    })
    expect(out).toContain('Invalid review path')
    expect(execCalled).toBe(false)
  })

  it('scopes the diff to the given paths and reports them when clean', async () => {
    const seen: string[][] = []
    const out = await reviewWorkspaceChanges({
      provider: base().provider,
      model: 'm',
      workspace: '/ws',
      paths: ['src/api'],
      signal: new AbortController().signal,
      gitExec: async (args) => {
        seen.push(args)
        if (args[0] === 'rev-parse') return 'true'
        return ''
      },
      runAgent: fakeAgent(() => 'unused').fn
    })
    const diffArgs = seen.find((a) => a[0] === 'diff')!
    expect(diffArgs).toContain('src/api')
    expect(out).toContain('No uncommitted changes')
    expect(out).toContain('src/api')
  })
})
