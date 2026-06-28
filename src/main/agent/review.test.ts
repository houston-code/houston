import { describe, it, expect } from 'vitest'
import type { SubAgentOptions } from './subagent'
import {
  formatReviewInput,
  isSafeReviewPath,
  reviewWorkspaceChanges,
  runReview,
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
