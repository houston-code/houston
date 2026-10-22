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

/** The dist wrapper the `package` job runs; it owns the `--publish` policy. */
const distScript = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/dist-with-retry.sh'),
  'utf8'
)

/** The leg policy `plan` runs; the runner labels for every package leg live here. */
const planScript = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/ci-plan.mjs'),
  'utf8'
)

const SHIPPED_RUNNERS = ['ubuntu-22.04', 'macos-15', 'macos-15-intel', 'windows-2025']

/** The `revert-guard:` job, from its key to the end of the file. */
const revertGuardJob = workflow.slice(workflow.indexOf('\n  revert-guard:'))

describe('CI revert guard', () => {
  it('defines a revert-guard job that runs on pull requests', () => {
    expect(workflow).toContain('\n  revert-guard:')
    expect(revertGuardJob).toContain("if: github.event_name == 'pull_request'")
  })

  it('checks the merge result against the PR base, not the PR branch in isolation', () => {
    // actions/checkout on a pull_request event lands on refs/pull/N/merge, this PR
    // already merged into its base, so HEAD is the tree that merging would produce and
    // HEAD^1 the tree it was built on. That pair is the real before/after for a PR on main,
    // on a release line, or in a stack. A freshly fetched base branch is not: main moving
    // after the merge ref was built (always, for a stacked PR, whose merge ref sits on a
    // snapshot of main) makes everything that landed since look like a revert.
    expect(revertGuardJob).toContain('run: node scripts/merge-revert-guard.mjs HEAD^1 HEAD')
    expect(revertGuardJob).not.toContain('"origin/$BASE"')
  })

  it('fetches enough history for the guard to see recent work on the base', () => {
    // The guard scans main's recent commits (WINDOW in merge-revert-guard.mjs) to tell a
    // deliberate removal from one that collides with work landed while the branch was
    // open. A depth-1 checkout would make that scan silently empty, and an empty scan
    // means the guard finds nothing and passes everything.
    expect(revertGuardJob).toContain('fetch-depth: 0')
  })

  it('honors the intentional-revert label as the documented override', () => {
    expect(revertGuardJob).toMatch(/ALLOW_REVERT:/)
    expect(revertGuardJob).toMatch(/labels\.\*\.name, 'intentional-revert'/)
  })

  it('relaxes the guard for dependency updates only on PRs Dependabot authored', () => {
    // The PR author, not the event actor: the notices regeneration pushes to the branch
    // as another identity, and that run must keep the exemption.
    expect(revertGuardJob).toContain(
      "DEPENDENCY_UPDATE: ${{ github.event.pull_request.user.login == 'dependabot[bot]' && '1' || '' }}"
    )
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

describe('CI never scopes away a required check', () => {
  it('has no path scoping that could skip a required check', () => {
    // A job skipped by a condition reports its required check as a PASS, so any scoping
    // is a way for an untested change to merge. A workflow-level `paths:` filter is
    // worse: it leaves a required check permanently "Expected".
    expect(workflow).not.toContain('\n  scope:')
    expect(workflow).not.toContain('needs.scope')
    expect(workflow).not.toMatch(/^ {2}paths(-ignore)?:/m)
  })

  it('lets `plan` choose package legs only, never whether a required check runs', () => {
    // `plan` may skip `package` (prose-only changes) and trims its legs; `test`,
    // `linux-sandbox` and `revert-guard` must not depend on it at all.
    for (const name of ['test', 'linux-sandbox', 'revert-guard']) {
      expect(job(name), name).not.toMatch(/^ {4}needs:/m)
    }
    expect(job('package')).toContain('needs: plan')
    expect(job('package')).toContain("needs.plan.outputs.package == 'true'")
    expect(job('package')).toContain('matrix: ${{ fromJSON(needs.plan.outputs.package-matrix) }}')
    expect(job('plan')).toContain('run: node scripts/ci-plan.mjs >> "$GITHUB_OUTPUT"')
  })

  it('diffs what lands: the PR merge, the queue candidate against its base, the push against main before it', () => {
    const plan = job('plan')
    expect(plan).toContain('pull_request) base=HEAD^1 ;;')
    expect(plan).toContain('QUEUE_BASE: ${{ github.event.merge_group.base_sha }}')
    expect(plan).toContain('PUSH_BEFORE: ${{ github.event.before }}')
    // A failed diff leaves the file list out, and ci-plan.mjs then assumes everything changed.
    expect(plan).toContain('git diff --name-only "$base" HEAD > "$files" || exit 0')
  })

  it('never scopes away the revert guard', () => {
    expect(revertGuardJob).not.toContain('needs:')
  })

  it('packages and tests on every platform it ships on', () => {
    const pkg = job('package')
    // The legs are defined in ci-plan.mjs; the nightly run takes all of them.
    for (const os of SHIPPED_RUNNERS) expect(planScript).toContain(`os: '${os}'`)
    expect(workflow).toMatch(/^ {2}schedule:\n {4}- cron: /m)
    // The full unit suite on every non-Linux leg (macOS against the real Seatbelt backend,
    // Windows against its own; Linux runs it in `test`), and the e2e on macOS.
    expect(pkg).toMatch(/if: runner\.os != 'Linux'\n {8}run: \|\n(?: {10}.*\n)*? {10}npm test /)
    expect(pkg).not.toContain('npx vitest run src/main/sandbox')
    expect(pkg).toMatch(/if: runner\.os == 'macOS'\n {8}run: npm run test:e2e/)
  })

  it('runs the Windows unit suite with its temp dirs on D:, off the OS disk', () => {
    // %TEMP% on a Windows runner is under the user profile on C:, the OS disk, which is
    // slower than D: and has stalled long enough to time tests out. RUNNER_TEMP is on D:.
    expect(job('package')).toContain(
      'if [ "$RUNNER_OS" = Windows ]; then export TEMP="$RUNNER_TEMP" TMP="$RUNNER_TEMP"; fi\n          npm test '
    )
  })
})

describe('CI gates merge on the whole matrix', () => {
  it('makes the required `build` check depend on the plan, every platform leg, the SBOM gate, and workflow-lint', () => {
    expect(job('build')).toContain('needs: [plan, package, sbom-conformance, workflow-lint]')
  })

  it('fails `build` when a dependency fails, instead of skipping it to a pass', () => {
    // Without a status function, a failed leg skips `build`, and a skipped required check
    // reports a PASS: a red macOS e2e would let the PR merge. With one, the job must check
    // every result itself, and anything but success (failure, skipped, cancelled) fails it.
    const build = job('build')
    expect(build).toMatch(/if: \$\{\{ !cancelled\(\) && /)
    expect(build).toContain('for r in "$PLAN" "$SBOM" "$LINT"; do')
    expect(build).toContain('[ "$r" = success ] ||')
    expect(build).toContain('[ "$PACKAGE" = success ] ||')
  })

  it('accepts a skipped `package` only when a successful plan planned no legs', () => {
    const build = job('build')
    expect(build).toContain('PLAN: ${{ needs.plan.result }}')
    expect(build).toContain('PACKAGE_PLANNED: ${{ needs.plan.outputs.package }}')
    expect(build).toMatch(/if \[ "\$PACKAGE_PLANNED" = false \]; then\n {12}\[ "\$PACKAGE" = skipped \] \|\|/)
  })

  it('skips `build` in a cancelled run, so a superseded run cannot leave a red required check', () => {
    // always() runs the job even after the concurrency group cancels the run; it then sees
    // its cancelled dependencies, fails, and that stale failure blocks the PR although the
    // newer run passed. Real failures still run it, since only cancellation stops it.
    expect(job('build')).not.toContain('always()')
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
    expect(job('package')).toMatch(/DIST: \$\{\{ matrix\.dist \}\}\n {8}run: bash scripts\/dist-with-retry\.sh "\$DIST"\n/)
    expect(distScript).toContain('npm run "$dist" -- --publish never')
    expect(distScript).not.toMatch(/--publish (always|onTag|onTagOrDraft)/)
  })
})

describe('CI validates every PR before it can merge', () => {
  it('runs the full suite on pull requests', () => {
    for (const check of ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test']) {
      expect(workflow).toContain(check)
    }
  })

  it('enforces the coverage floors in the Linux test job', () => {
    // The per-directory thresholds in vitest.config.ts only bite when coverage runs;
    // without --coverage here they would silently never gate anything.
    expect(job('test')).toMatch(/run: npm test -- --coverage /)
  })

  it('re-tests main after each merge', () => {
    // Queue merges are real pushes, so this trigger fires and main is checked after the
    // fact — the backstop for a broken two-PR combination that per-PR CI cannot see.
    expect(workflow).toMatch(/push:\n {4}branches: \[main\]/)
  })
})

describe('CI lints its own workflows', () => {
  it('runs actionlint and zizmor with pinned, verified installs', () => {
    const lint = job('workflow-lint')
    expect(lint).toContain('sha256sum -c -')
    expect(lint).toContain('--require-hashes')
    expect(lint).toMatch(/run: actionlint/)
    expect(lint).toMatch(/run: zizmor .*--min-severity low --config \.github\/zizmor\.yml \.github\/workflows \.github\/actions/)
  })

  it('lints the GitHub Action and its example workflows too', () => {
    const lint = job('workflow-lint')
    expect(lint).toMatch(/run: zizmor .* action action\/examples\/\*\.yml\n/)
    expect(lint).toContain('run: actionlint -color action/examples/*.yml')
  })

  it('lints queue candidates too, so the required `build` check never sees it skipped', () => {
    expect(job('workflow-lint')).toContain("if: github.event_name != 'push'")
  })
})

describe('CI alerts on a red main', () => {
  it('files an issue when the post-merge or nightly run fails, since neither has a reliable actor', () => {
    const alert = job('alert')
    expect(alert).toContain("(github.event_name == 'push' || github.event_name == 'schedule')")
    expect(alert).toContain('uses: ./.github/workflows/alert-on-failure.yml')
    // `build` carries the package legs nightly (it is skipped on push).
    expect(alert).toContain('needs: [test, linux-sandbox, build]')
    expect(alert).toContain("workflow: ${{ github.event_name == 'schedule' && 'CI nightly' || 'CI on main' }}")
    expect(alert).toContain("failed: ${{ contains(needs.*.result, 'failure') }}")
  })

  it('grants the alert only issue access', () => {
    expect(job('alert')).toMatch(/permissions:\n {6}issues: write\n/)
  })
})

describe('CI reports and caches', () => {
  it('uploads JUnit results from every leg that runs the unit suite, even when it fails', () => {
    for (const name of ['test', 'package']) {
      const block = job(name)
      expect(block).toContain('--reporter=junit --outputFile.junit=reports/junit.xml')
      expect(block).toContain('--reporter=github-actions')
      expect(block).toMatch(/- name: Upload test results\n {8}if: \$\{\{ !cancelled\(\)/)
    }
  })

  it('caches only the Electron headers in install-only jobs', () => {
    // npm ci's postinstall rebuilds node-pty against the Electron headers; a CDN timeout
    // there once failed `test` on main. These jobs never package, so they never download
    // the Electron runtime.
    for (const name of ['test', 'linux-sandbox']) {
      expect(job(name)).toMatch(/uses: \.\/\.github\/actions\/setup-node\n {8}with:\n(?: {10}.*\n)* {10}electron-cache: headers\n/)
    }
  })

  it('caches the Electron runtime and builder tools in every job that packages', () => {
    for (const name of ['package', 'warm-caches']) {
      expect(job(name)).toMatch(/electron-cache: full\n/)
    }
  })

  it('keeps the two cache kinds under separate keys, restored before npm ci', () => {
    // A shared key let an install-only job save a near-empty entry that the packaging job
    // then hit and never replaced (Linux cached 0 MB of Electron).
    const action = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/actions/setup-node/action.yml'),
      'utf8'
    )
    expect(action).toContain("key: electron-headers-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}")
    expect(action).toContain("key: electron-full-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('package-lock.json') }}")
    expect(action).not.toContain('GITHUB_ENV')
    // A typo (e.g. `electron-cache: true`) must fail, not silently cache nothing.
    expect(action).toContain("unknown electron-cache '$MODE' (expected false, headers or full)")
    expect(action.lastIndexOf('uses: actions/cache@')).toBeLessThan(action.indexOf('npm ci ;;'))
  })
})

describe('CI is the release gate', () => {
  it('is callable as a reusable workflow', () => {
    expect(workflow).toMatch(/^ {2}workflow_call:$/m)
  })

  it('is what release-prepare verifies the release tree with, on the exact commit it cuts', () => {
    const prepare = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/release-prepare.yml'),
      'utf8'
    )
    expect(prepare).toMatch(/\n {2}verify:\n {4}needs: plan\n {4}if: .*\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n/)
    expect(prepare).toContain('needs: [plan, native-scan, sbom-conformance, verify, build]')
    // Called that way, CI tests `ref` and leaves packaging and SBOMs to publish's own jobs.
    for (const name of ['test', 'linux-sandbox', 'package', 'workflow-lint']) {
      expect(job(name), name).toContain('ref: ${{ inputs.ref || github.sha }}')
    }
    expect(job('package')).toContain("if: github.event_name != 'push' && !inputs.release")
    expect(workflow).toContain("  sbom-conformance:\n    if: github.event_name != 'push' && !inputs.release\n")
  })

  it('checks a release PR\'s notes and that it changes only the version and CHANGELOG', () => {
    const notes = job('release-notes')
    expect(notes).toContain("if: github.event_name == 'pull_request' && startsWith(github.head_ref, 'release-pr/v')")
    expect(notes).toContain('HEAD_REF: ${{ github.head_ref }}')
    expect(notes).toContain('node scripts/check-changelog-summary.mjs "$version"')
    expect(notes).toContain("grep -v -x -E 'CHANGELOG\\.md|package\\.json|package-lock\\.json'")
  })
})

describe('CI keeps PR caches warm', () => {
  it('refreshes the PR and queue legs\' caches from main, where every PR can read them', () => {
    // PR- and queue-scoped caches are invisible to other PRs, and `package` skips push.
    const warm = job('warm-caches')
    expect(warm).toContain("if: github.event_name == 'push' && needs.plan.outputs.warm-caches == 'true'")
    for (const os of ['ubuntu-22.04', 'macos-15', 'windows-2025']) expect(warm).toContain(`os: ${os}\n`)
    // Intel runs only nightly, whose package legs save main-scoped caches themselves.
    expect(warm).not.toContain('macos-15-intel')
    expect(warm).toMatch(/install: full\n {10}electron-cache: full/)
  })

  it('packages without publishing, so the tool downloads are cached too', () => {
    expect(job('warm-caches')).toContain('run: npm run "$DIST" -- --publish never')
  })

  it('uses the same runners as the package legs, so the cache keys match', () => {
    for (const os of ['ubuntu-22.04', 'macos-15', 'windows-2025']) {
      expect(job('warm-caches')).toContain(`os: ${os}\n`)
      expect(planScript).toContain(`os: '${os}'`)
    }
  })

  it('never gates a merge: it runs only after the merge, and `build` does not need it', () => {
    expect(job('build')).not.toContain('warm-caches')
  })
})
