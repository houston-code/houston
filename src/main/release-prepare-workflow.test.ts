import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the release-prepare workflow: that it runs Release - publish's own checks on the
 * commit it cuts, in publish's order, before the notes and the PR; and that the release PAT
 * stays confined to the steps that need it. The workflow is workflow_dispatch-only, so nothing
 * on a normal PR exercises it; these assertions are the only automated check.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release-prepare.yml'), 'utf8')

/** A top-level job's block, from its key to the next job key. */
function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`)
  if (start === -1) throw new Error(`job not found: ${name}`)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

// A step's body: from its `- name:` marker to the start of the next step at the same indent.
function step(name: string): string {
  const start = workflow.indexOf(`- name: ${name}`)
  if (start === -1) throw new Error(`step not found: ${name}`)
  const rest = workflow.slice(start + 1)
  const next = rest.indexOf('\n      - ')
  return next === -1 ? rest : rest.slice(0, next)
}

describe('release-prepare release-PR token', () => {
  it('opens the release PR with the PAT so its required checks run', () => {
    // A PR opened by GITHUB_TOKEN triggers no workflows, so the merge queue could never land it.
    const open = step('Open release PR')
    expect(open).toContain('GH_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}')
    expect(open).toContain('gh pr create')
  })

  it('fails loudly when the PAT is missing instead of opening nothing', () => {
    const open = step('Open release PR')
    expect(open).toMatch(/if \[ -z "\$GH_TOKEN" \]/)
    expect(open).toContain('exit 1')
  })

  it('references the PAT only to open the PR', () => {
    // Earlier steps run npm install and the note generator (third-party code); the PAT must
    // not reach their environment or the checkout's persisted credentials.
    expect(workflow.match(/secrets\.RELEASE_PR_TOKEN/g)).toHaveLength(1)
    expect(step('Open release PR')).toContain('GH_TOKEN: ${{ secrets.RELEASE_PR_TOKEN }}')
    expect(workflow).not.toMatch(/token: \$\{\{ secrets\.RELEASE_PR_TOKEN/)
  })

  it('reads the PAT from the main-only release-pr environment', () => {
    expect(job('prepare')).toMatch(/^ {4}environment: release-pr$/m)
  })

  it("creates branches and pushes with the workflow's own token, which the PAT lacks rights for", () => {
    // The first real run failed creating release/0.9 with the PAT ("Resource not accessible
    // by personal access token"): it can open PRs but not write contents.
    const open = step('Open release PR')
    expect(open).toContain('PUSH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(open).toContain('GH_TOKEN="$PUSH_TOKEN" gh api "repos/$GITHUB_REPOSITORY/git/refs"')
    expect(open).toContain('git push --quiet --force "https://x-access-token:${PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"')
    expect(open).not.toContain('x-access-token:${GH_TOKEN}')
    expect(job('prepare')).toContain('contents: write')
    expect(job('prepare')).toContain('persist-credentials: false')
    const line = step('Create the release line')
    expect(line).toContain('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
    expect(job('line-only')).toContain('contents: write')
    expect(job('line-only')).not.toContain('environment:')
  })

  it("reopens an open release PR on update, since a GITHUB_TOKEN push won't re-run its checks", () => {
    // Closing and reopening with the PAT fires `reopened`, which ci.yml runs on, so the checks
    // cover the new commit; the PR keeps its number and conversation.
    const open = step('Open release PR')
    expect(open.indexOf('git push --quiet --force')).toBeLessThan(open.indexOf('gh pr close "$open"'))
    expect(open.indexOf('gh pr close "$open"')).toBeLessThan(open.indexOf('gh pr reopen "$open"'))
    expect(open).toContain('exit 0')
    const ci = readFileSync(resolve(repoRoot, '.github/workflows/ci.yml'), 'utf8')
    expect(ci).toContain('types: [opened, synchronize, reopened, labeled]')
  })
})

describe('release-prepare inputs', () => {
  it('offers the four choices, in order, plus a required version', () => {
    expect(workflow).toContain(
      'options:\n          - Next minor version\n          - Next major version\n          - Patch a release\n          - Update pending release\n'
    )
    expect(workflow).toMatch(/version:\n {8}description: .*\n {8}type: string\n {8}required: true/)
  })

  it('validates them in plan, from main only, passing inputs through the environment', () => {
    const plan = job('plan')
    expect(plan).toContain('if [ "$GITHUB_REF" != refs/heads/main ]; then')
    expect(plan).toContain('CHOICE: ${{ inputs.release }}')
    expect(plan).toContain('VERSION: ${{ inputs.version }}')
    expect(plan).toContain('node scripts/release-source.mjs plan')
    // Piped into tee: without pipefail a refusal would pass with empty outputs.
    expect(plan.indexOf('set -euo pipefail')).toBeGreaterThan(-1)
    expect(plan.indexOf('set -euo pipefail')).toBeLessThan(plan.indexOf('| tee -a "$GITHUB_OUTPUT"'))
    // Inputs reach run scripts through env, so an input can never become shell syntax.
    const code = workflow
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n')
    const blocks = code.match(/run: \|\n([\s\S]*?)(?=\n {6}- |\n {0,4}\S|$)/g) ?? []
    expect(blocks.length).toBeGreaterThan(3)
    for (const block of blocks) expect(block).not.toContain('${{ inputs.')
  })
})

describe("release-prepare runs publish's checks first", () => {
  it('scans and SBOM-checks the pinned commit with the same called workflows as publish', () => {
    expect(job('native-scan')).toContain('uses: ./.github/workflows/native-vuln-scan.yml')
    expect(job('sbom-conformance')).toContain('uses: ./.github/workflows/sbom-conformance.yml')
    for (const name of ['native-scan', 'sbom-conformance']) {
      expect(job(name)).toContain('ref: ${{ needs.plan.outputs.sha }}')
    }
  })

  it("builds every platform with publish's own leg, unsigned and uploading nothing", () => {
    const build = job('build')
    expect(build).toContain('needs: [plan, native-scan, sbom-conformance]')
    expect(build).toContain('uses: ./.github/workflows/release-build.yml')
    expect(build).toContain('ref: ${{ needs.plan.outputs.sha }}')
    expect(build).toContain('sign: false')
    expect(build).toContain('dry_run: true')
    for (const os of ['macos-15', 'macos-15-intel', 'windows-2025', 'ubuntu-22.04']) expect(build).toContain(`os: ${os}\n`)
    // No signing credentials are passed, and there is no approval gate.
    expect(build).not.toContain('secrets:')
    expect(workflow).not.toContain('release-approval')
  })

  it("runs CI's tests on the same commit, leaving packaging to the legs", () => {
    const verify = job('verify')
    expect(verify).toContain('uses: ./.github/workflows/ci.yml')
    expect(verify).toContain('ref: ${{ needs.plan.outputs.sha }}')
    expect(verify).toContain('release: true')
  })

  it('writes the notes and opens the PR last, only after every check passed', () => {
    const prepare = job('prepare')
    expect(prepare).toContain('needs: [plan, native-scan, sbom-conformance, verify, build]')
    expect(prepare).toContain('ref: ${{ needs.plan.outputs.sha }}')
    expect(prepare.indexOf('- name: Generate release notes')).toBeLessThan(prepare.indexOf('- name: Open release PR'))
  })

  it('records the cut in the release commit and targets the release line', () => {
    const open = step('Open release PR')
    expect(open).toContain('git commit -qm "release: v$VERSION" -m "Release-Base: $SHA"')
    expect(open).toContain('gh pr create -R "$GITHUB_REPOSITORY" --base "$LINE" --head "$branch"')
    expect(open).toContain('branch="release-pr/v$VERSION"')
  })

  it('can push its branches and read the PRs it describes, and nothing more', () => {
    const prepare = job('prepare')
    expect(prepare).toMatch(/permissions:\n {6}contents: write # .*\n {6}pull-requests: read # /)
    expect(prepare).not.toContain('pull-requests: write')
    expect(prepare).not.toContain('id-token')
  })

  it("collects the notes' PRs from history and keeps an existing section in place", () => {
    const notes = step('Generate release notes')
    expect(notes).toContain('node scripts/release-source.mjs prs')
    expect(notes).toContain('node scripts/changelog-upsert.mjs "$VERSION" .release-section.md CHANGELOG.md')
    expect(notes).not.toContain('--search "merged:>')
  })
})
