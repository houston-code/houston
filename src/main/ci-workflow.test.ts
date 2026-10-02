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

/** A top-level job's block, from its key to the next top-level job key. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:`)
  expect(start).toBeGreaterThan(-1)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

describe('CI runs everything on every PR', () => {
  it('has no path scoping that could skip a required check', () => {
    // A job skipped by a condition reports its required check as a PASS, so any scoping
    // is a way for an untested change to merge. A workflow-level `paths:` filter is
    // worse: it leaves a required check permanently "Expected".
    expect(workflow).not.toContain('\n  scope:')
    expect(workflow).not.toContain('needs.scope')
    expect(workflow).not.toMatch(/^ {2}paths(-ignore)?:/m)
  })

  it('never scopes away the revert guard', () => {
    expect(revertGuardJob).not.toContain('needs:')
  })

  it('packages and tests on every platform it ships on', () => {
    const pkg = job('package')
    for (const os of ['ubuntu-22.04', 'macos-14', 'macos-15-intel', 'windows-latest']) {
      expect(pkg).toContain(`os: ${os}`)
    }
    // The macOS unit suite (real Seatbelt), the Windows sandbox suite, and the
    // packaged-app e2e on the macOS legs.
    expect(pkg).toMatch(/if: matrix\.target == 'mac-arm64'\n {8}run: npm test/)
    expect(pkg).toMatch(/if: runner\.os == 'Windows'\n {8}run: npx vitest run src\/main\/sandbox/)
    expect(pkg).toMatch(/if: runner\.os == 'macOS'\n {8}run: npm run test:e2e/)
  })
})

describe('CI gates merge on the whole matrix', () => {
  it('makes the required `build` check depend on every platform leg and the SBOM gate', () => {
    expect(job('build')).toContain('needs: [package, sbom-conformance]')
  })

  it('fails `build` when a dependency fails, instead of skipping it to a pass', () => {
    // Without always(), a failed leg skips `build`, and a skipped required check reports
    // a PASS: a red macOS e2e would let the PR merge. With it, the job must check every
    // result itself, and anything but success (failure, skipped, cancelled) fails it.
    const build = job('build')
    expect(build).toMatch(/if: \$\{\{ always\(\) && /)
    expect(build).toContain("join(needs.*.result, ' ')")
    expect(build).toContain('[ "$r" = success ] ||')
  })
})

describe('CI supports the merge queue', () => {
  it('runs on merge_group, so queue candidates report the required checks', () => {
    // Without this trigger the checks never report on the candidate commit and the queue
    // stalls on every entry.
    expect(workflow).toMatch(/^ {2}merge_group:$/m)
  })

  it('packages a queue candidate, not just a PR', () => {
    // `== 'pull_request'` would skip packaging on a candidate, so a packaging break could
    // reach main through the queue.
    for (const name of ['package', 'sbom-conformance']) {
      expect(job(name)).toContain("if: github.event_name != 'push'")
    }
    expect(job('build')).toContain("github.event_name != 'push'")
  })

  it('never lets electron-builder publish from a queue candidate', () => {
    // A merge_group run has no GITHUB_BASE_REF, so electron-builder does not see a PR and
    // publishes implicitly unless told not to. With no token that fails packaging, and the
    // queue ejects every entry.
    expect(job('package')).toContain('npm run ${{ matrix.dist }} -- --publish never')
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
