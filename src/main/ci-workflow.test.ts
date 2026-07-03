import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the CI merge-safety invariant, not application code — but it lives in the
 * node test project so it runs in the same `npm test` that gates every PR.
 *
 * Background: PRs are tested against GitHub's merge ref (`main + PR` at event
 * time). With no branch protection / merge queue on this plan, `gh pr merge` will
 * land a PR against a *newer* main than it was tested against, so an untested
 * combination can break main and then redden every later PR's merge ref — green
 * per-PR, red on merge, queue blocked. The `auto-merge` job defends against this
 * by re-validating the real landing commit (current main + PR) and merging only
 * if green. These assertions fail loudly if that gate is ever weakened or removed.
 */
const workflow = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/ci.yml'),
  'utf8'
)

// The part of the workflow from the `auto-merge:` job to the end of the file.
const autoMergeJob = workflow.slice(workflow.indexOf('\n  auto-merge:'))

describe('CI auto-merge gate', () => {
  it('defines an auto-merge job', () => {
    expect(workflow).toContain('\n  auto-merge:')
  })

  it('validates the real landing commit against main, not the stale PR merge ref', () => {
    // Checks out main and reproduces the merge locally before testing.
    expect(autoMergeJob).toContain('ref: main')
    expect(autoMergeJob).toMatch(/git merge .*pr-head/)
  })

  it('runs the full suite before merging', () => {
    for (const check of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test']) {
      expect(autoMergeJob).toContain(check)
    }
  })

  it('runs the suite BEFORE the merge call, so a broken combination never lands', () => {
    const validateAt = autoMergeJob.indexOf('npm test')
    // The real merge command (prose comments also mention `gh pr merge`).
    const mergeAt = autoMergeJob.indexOf('gh pr merge "$PR"')
    expect(validateAt).toBeGreaterThanOrEqual(0)
    expect(mergeAt).toBeGreaterThanOrEqual(0)
    expect(validateAt).toBeLessThan(mergeAt)
  })

  it('only merges when main has not advanced since validation (compare-and-swap)', () => {
    // A second fetch of main after validation, compared against the validated base.
    expect(autoMergeJob).toContain('git rev-parse FETCH_HEAD')
    expect(autoMergeJob).toMatch(/!= "\$base"/)
  })

  it('falls back to an optional PAT so workflow-editing PRs can auto-merge', () => {
    // The default GITHUB_TOKEN can't merge PRs that touch .github/workflows/**.
    expect(autoMergeJob).toMatch(/secrets\.AUTOMERGE_PAT \|\| secrets\.GITHUB_TOKEN/)
  })
})
