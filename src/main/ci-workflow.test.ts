import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards CI's merge-safety invariants, not application code — but it lives in the
 * node test project so it runs in the same `npm test` that gates every PR.
 *
 * History: this file used to pin a bespoke `auto-merge` job that reproduced the real
 * landing commit locally, re-validated it, and fast-forward-pushed it to main. That
 * machinery existed for one reason, stated in its own comments: the repo had no branch
 * protection, so nothing could require a PR to be up to date before merging, and a PR
 * green against a stale main could land an untested combination.
 *
 * That premise is gone. Branch protection now enforces strict (up-to-date) required
 * status checks, so the merge ref CI tests IS the tree that lands, and merges are made
 * by a human rather than by a labelled job holding a repo-write PAT. What remains worth
 * pinning is what branch protection cannot express: that the revert guard actually runs
 * on the landing tree, and that no PR-triggered job carries a push credential.
 *
 * Branch-protection settings themselves are NOT asserted here — they live in GitHub, not
 * in the tree, so a test could only assert a copy of them. They are documented in
 * CONTRIBUTING.md instead.
 */
const workflow = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/ci.yml'),
  'utf8'
)

/** The `revert-guard:` job, from its key to the end of the file. */
const revertGuardJob = workflow.slice(workflow.indexOf('\n  revert-guard:'))

describe('CI revert guard', () => {
  it('defines a revert-guard job that runs on pull requests', () => {
    expect(workflow).toContain('\n  revert-guard:')
    expect(revertGuardJob).toContain("if: github.event_name == 'pull_request'")
  })

  it('checks the merge result against main, not the PR branch in isolation', () => {
    // actions/checkout on a pull_request event lands on refs/pull/N/merge — this PR
    // already merged into main — so HEAD is the tree that merging would produce.
    // Comparing origin/main..HEAD is therefore the real before/after.
    expect(revertGuardJob).toMatch(/merge-revert-guard\.mjs origin\/main HEAD/)
  })

  it('fetches enough history for the guard to see recent work on main', () => {
    // The guard scans main's recent commits (WINDOW in merge-revert-guard.mjs) to tell a
    // deliberate removal from one that collides with work landed while the branch was
    // open. A depth-1 checkout would make that scan silently empty, and an empty scan
    // means the guard finds nothing and passes everything.
    expect(revertGuardJob).toContain('fetch-depth: 0')
    expect(revertGuardJob).toMatch(/git fetch .*origin main/)
  })

  it('honors the intentional-revert label as the documented override', () => {
    expect(revertGuardJob).toMatch(/ALLOW_REVERT:/)
    expect(revertGuardJob).toMatch(/labels\.\*\.name, 'intentional-revert'/)
  })

  it('re-runs when a label changes, so applying intentional-revert takes effect', () => {
    // Without `labeled` in the trigger types, adding the override label would not start a
    // new run and the guard would keep reporting its pre-label failure.
    expect(workflow).toMatch(/types: \[.*labeled.*\]/)
  })
})

describe('CI holds no push credentials', () => {
  it('has no auto-merge job or merge PAT', () => {
    // Merges are made by a human. Nothing in CI pushes to main, so no job needs a
    // repo-write credential. Re-introducing one would mean a PR's own code (its npm
    // lifecycle scripts, its tests) executes in a job that can read that secret.
    expect(workflow).not.toContain('\n  auto-merge:')
    expect(workflow).not.toContain('AUTOMERGE_PAT')
  })

  it('never pushes to main from CI', () => {
    expect(workflow).not.toMatch(/git push .*HEAD:main/)
    expect(workflow).not.toMatch(/gh pr merge/)
  })

  it('keeps the workflow token read-only at the top level', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read$/m)
  })
})

describe('CI validates every PR before it can merge', () => {
  it('runs the full suite on pull requests', () => {
    for (const check of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test']) {
      expect(workflow).toContain(check)
    }
  })

  it('re-tests main after each merge', () => {
    // Human merges are real pushes, so this trigger fires and main is checked after the
    // fact — the backstop for a broken two-PR combination that per-PR CI cannot see.
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/)
  })
})
