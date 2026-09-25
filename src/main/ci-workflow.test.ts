import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards CI's merge-safety invariants, not application code — but it lives in the
 * node test project so it runs in the same `npm test` that gates every PR.
 *
 * A ruleset on main requires the checks and routes every merge through the merge
 * queue, so the candidate CI tests IS the tree that lands. What is worth pinning is what
 * the ruleset cannot express: that the revert guard actually runs on the PR's merge
 * tree, that the queue's candidates get the checks it waits on, and that no
 * PR-triggered job carries a push credential.
 *
 * Ruleset settings themselves are NOT asserted here — they live in GitHub, not
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

describe('CI scopes work to what a change can affect', () => {
  it('gates the heavy jobs on the scope job, never on a raw path filter', () => {
    // A workflow-level `paths:` filter would leave a required check permanently
    // "Expected" and block the PR forever. Gating a job on a computed output keeps the
    // check reporting; the job is skipped, and a skipped job reports as a pass.
    expect(workflow).toContain('\n  scope:')
    expect(workflow).not.toMatch(/^ {2}paths(-ignore)?:/m)
    const scoped = workflow.match(/needs\.scope\.outputs\.inert != 'true'/g) ?? []
    expect(scoped).toHaveLength(2) // test + linux-sandbox; build inherits via needs: test
  })

  it('runs the full suite when the scope job itself fails', () => {
    // Without `!cancelled()`, a failed `scope` would skip its dependents for an
    // unsatisfied `needs`, and a skipped required check reports a PASS — so a network
    // blip in the scope job would silently mark an untested PR mergeable. The guard
    // makes a failed scope leave `inert` empty, which runs everything.
    const guards = workflow.match(/!cancelled\(\) && needs\.scope\.outputs\.inert != 'true'/g) ?? []
    expect(guards).toHaveLength(2)
  })

  it('never gates the scope job itself on an event', () => {
    // Same skip-is-a-pass mechanism, one level up: an `if:` on `scope` would skip every
    // consumer via `needs`, silently disabling `test` and `linux-sandbox` on main and on
    // merge-queue candidates while reporting them green. The CHECKOUT step inside may be
    // conditional; the job may not.
    const scopeJob = workflow.slice(workflow.indexOf('\n  scope:'), workflow.indexOf('\n  test:'))
    const jobLevelIf = scopeJob.match(/^ {4}if:/m)
    expect(jobLevelIf).toBeNull()
  })

  it('treats anything but a definite "inert" as run-everything', () => {
    // The output is empty on non-PR events. `!= 'true'` runs the suite for empty, for
    // 'false', and for anything unexpected; `== 'false'` would skip on an empty value.
    expect(workflow).not.toContain("needs.scope.outputs.inert == 'false'")
  })

  it('scopes pull requests only, never main or a queue candidate', () => {
    // Those are the trees that ship. Scoping them would mean main could land untested.
    const scopeJob = workflow.slice(workflow.indexOf('\n  scope:'), workflow.indexOf('\n  test:'))
    expect(scopeJob).toContain("if: github.event_name == 'pull_request'")
    expect(scopeJob).toContain('fetch-depth: 0')
  })

  it('never scopes away the revert guard', () => {
    // It costs 8 seconds and matters most on exactly the stale branches that would
    // otherwise look cheap to skip.
    expect(revertGuardJob).not.toContain('needs.scope')
  })
})

describe('CI supports the merge queue', () => {
  it('runs on merge_group, so queue candidates report the required checks', () => {
    // Without this trigger the checks never report on the candidate commit and the queue
    // stalls on every entry.
    expect(workflow).toMatch(/^ {2}merge_group:$/m)
  })

  it('packages a queue candidate, not just a PR', () => {
    // `== 'pull_request'` would skip `build` on a candidate, so a packaging break could
    // reach main through the queue.
    const buildJob = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  revert-guard:'))
    expect(buildJob).toContain("if: github.event_name != 'push'")
  })

  it('never lets electron-builder publish from a queue candidate', () => {
    // A merge_group run has no GITHUB_BASE_REF, so electron-builder does not see a PR and
    // publishes implicitly unless told not to. With no token that fails `build`, and the
    // queue ejects every entry.
    const buildJob = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  revert-guard:'))
    expect(buildJob).toContain('npm run dist:linux -- --publish never')
  })
})

describe('CI validates every PR before it can merge', () => {
  it('runs the full suite on pull requests', () => {
    for (const check of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test']) {
      expect(workflow).toContain(check)
    }
  })

  it('re-tests main after each merge', () => {
    // Queue merges are real pushes, so this trigger fires and main is checked after the
    // fact — the backstop for a broken two-PR combination that per-PR CI cannot see.
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/)
  })
})
