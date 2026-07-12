import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the CI merge-safety invariant, not application code — but it lives in the
 * node test project so it runs in the same `npm test` that gates every PR.
 *
 * Background: PRs are tested against GitHub's merge ref (`main + PR` at event
 * time). With no branch protection / merge queue on this plan, a naive merge would
 * land a PR against a *newer* main than it was tested against, so an untested
 * combination can break main and then redden every later PR's merge ref — green
 * per-PR, red on merge, queue blocked. The `auto-merge` job defends against this by
 * reproducing the real landing commit locally (current main + PR), re-validating it,
 * folding the version bump into that merge commit, and fast-forward-pushing it to
 * main — which lands only if main is still where it was validated. These assertions
 * fail loudly if that gate is ever weakened or removed.
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

  it('runs the suite BEFORE the land push, so a broken combination never lands', () => {
    const validateAt = autoMergeJob.indexOf('npm test')
    // The land action: the locally-built merge+bump commit is pushed to main here.
    const landAt = autoMergeJob.indexOf('git push origin HEAD:main')
    expect(validateAt).toBeGreaterThanOrEqual(0)
    expect(landAt).toBeGreaterThanOrEqual(0)
    expect(validateAt).toBeLessThan(landAt)
  })

  it('only lands when main has not advanced since validation (compare-and-swap)', () => {
    // The landing commit is built on the exact main revision we validated against...
    expect(autoMergeJob).toContain('base=$(git rev-parse FETCH_HEAD)')
    expect(autoMergeJob).toContain('git checkout --quiet -B ci-land "$base"')
    // ...and pushed with a plain fast-forward push (NOT --force), so the push fails if a
    // concurrent PR advanced main past $base — that fast-forward rejection IS the swap.
    expect(autoMergeJob).toContain('git push origin HEAD:main')
    expect(autoMergeJob).not.toMatch(/git push [^\n]*--force[^\n]*HEAD:main/)
    // A rejected push re-validates against the new main instead of forcing over it.
    expect(autoMergeJob).toMatch(/rejected on attempt.*main advanced.*re-validating/)
  })

  it('folds the version bump into the merge commit, so each PR lands as one commit', () => {
    // The merge is staged but not committed (--no-commit), the patch bump is applied,
    // then both are committed together — one commit per PR carrying its own bump.
    expect(autoMergeJob).toContain('git merge --no-ff --no-commit pr-head')
    expect(autoMergeJob).toContain('npm version patch --no-git-tag-version')
    // `release`-labelled PRs already carry their minor bump, so the patch fold is skipped.
    expect(autoMergeJob).toMatch(/is_release.*=.*'release'/)
  })

  it('lets workflow-editing PRs land by pushing the fold with a PAT', () => {
    // The default GITHUB_TOKEN is a GitHub App token that GitHub blocks from PUSHING
    // commits that touch .github/workflows/**, so a workflow-editing PR pushes its folded
    // commit over a PAT-authenticated origin. GH_TOKEN also prefers the PAT for gh ops.
    expect(autoMergeJob).toMatch(/secrets\.AUTOMERGE_PAT \|\| secrets\.GITHUB_TOKEN/)
    expect(autoMergeJob).toContain('git remote set-url origin')
    expect(autoMergeJob).toMatch(/x-access-token:\$\{AUTOMERGE_PAT\}/)
    // The checkout injects the App-token Authorization as an http.<host>.extraheader that
    // git prefers over URL credentials; it must be dropped or the PAT push still auths as
    // the blocked App token.
    expect(autoMergeJob).toMatch(/unset-all 'http\.https:\/\/github\.com\/\.extraheader'/)
  })
})
