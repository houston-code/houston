import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * Guards the one workflow in this repo that holds a credential able to push to a branch.
 *
 * `ci-workflow.test.ts` pins the complementary invariant: ci.yml holds no push credential,
 * because ci.yml runs the PR's own tests and build, so any secret readable there is
 * readable by the PR's own code. The notices auto-commit needs a credential, so it lives
 * in its own workflow that runs no project code at all. These tests pin the properties
 * that make that isolation real — if one of them is edited away, the separation stops
 * being a separation and the credential is exposed to a dependency PR's package scripts.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/dependabot-notices.yml'), 'utf8')
const ciSource = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')

const doc = load(source) as any
// YAML 1.1 resolves a bare `on` key to boolean true; 1.2 keeps it a string. Accept either
// so the assertions below pin the workflow, not the parser's schema.
const triggers = doc.on ?? doc[true as unknown as string]
const job = doc.jobs.notices
const steps = job.steps as any[]
const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
const install = steps.find((s) => String(s.run ?? '').includes('npm ci'))
const commitStep = steps.find((s) => String(s.name ?? '').includes('Commit'))

describe('Dependabot notices workflow', () => {
  it('runs only on Dependabot pull requests', () => {
    // Gating on the actor keeps the credential-holding job off every human PR, where the
    // author can just run `npm run notices` locally.
    expect(triggers).toHaveProperty('pull_request')
    expect(job.if).toBe("github.actor == 'dependabot[bot]'")
  })

  it('commits to the PR branch, not the merge ref', () => {
    // A pull_request checkout defaults to refs/pull/N/merge, which is a detached
    // throwaway commit — pushing it back would not advance the branch.
    expect(checkout.with.ref).toBe('${{ github.event.pull_request.head.ref }}')
  })
})

describe('Dependabot notices workflow contains the credential', () => {
  it('keeps the ambient workflow token read-only', () => {
    // The push authenticates with the PAT. Nothing here should be able to write using the
    // token GitHub hands every step for free.
    expect(doc.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toEqual({ contents: 'read' })
  })

  it('never lets a dependency PR execute its own package scripts', () => {
    // THE load-bearing assertion. This job processes a PR that changes dependency
    // versions while a repo-write token is present in the run; a lifecycle script from a
    // newly bumped package is the one place that token could leak. The generator needs
    // the installed tree on disk, never any of it executed.
    expect(install.run).toContain('npm ci --ignore-scripts')
  })

  it('exposes the credential to the push step alone', () => {
    // Every other step runs third-party-adjacent work (an install, a generator walking
    // node_modules). Only the step that pushes should be able to read the secret.
    for (const step of steps) {
      const env = JSON.stringify(step.env ?? {})
      if (step === commitStep) expect(env).toContain('secrets.NOTICES_PAT')
      else expect(env).not.toContain('secrets.')
    }
  })

  it('leaves no checkout credential behind to shadow the push', () => {
    // actions/checkout persists an http.extraheader auth token in .git/config by default.
    // It takes precedence over a token in the push URL, so the push would silently use
    // the wrong identity — and a GITHUB_TOKEN push does not re-trigger CI (see below).
    expect(checkout.with['persist-credentials']).toBe(false)
  })

  it('is the only workflow that names the credential', () => {
    // ci.yml runs the PR's tests and build. The moment NOTICES_PAT is readable there, the
    // isolation this whole file guards is gone.
    expect(ciSource).not.toContain('NOTICES_PAT')
  })

  it('holds no credential that can write to main', () => {
    expect(source).not.toMatch(/HEAD:(refs\/heads\/)?main\b/)
    expect(source).not.toMatch(/gh pr merge/)
  })
})

describe('Dependabot notices workflow fails loudly when misconfigured', () => {
  it('errors on a stale file it cannot commit rather than skipping quietly', () => {
    // A silent skip on a missing secret would look exactly like "notices were already
    // current" — a dead gate reporting green, which is the failure mode this repo has
    // been bitten by before (see the all-zero eval baseline in AGENTS.md).
    expect(commitStep.run).toMatch(/if \[ -z "\$\{NOTICES_PAT\}" \]/)
    expect(commitStep.run).toContain('::error::')
    expect(commitStep.run).toMatch(/exit 1/)
  })

  it('refuses to commit anything but the notices file', () => {
    // A blind `git commit -a` here would sweep any other change the install or generator
    // left behind into a dependency PR, unreviewed.
    expect(commitStep.run).toContain('git add -- THIRD-PARTY-NOTICES.md')
    expect(commitStep.run).toMatch(/Refusing to commit/)
  })

  it('does not attribute its commit to Dependabot', () => {
    // The commit is made by this workflow, not by Dependabot. Impersonating it would
    // misreport who generated the file.
    expect(commitStep.run).toContain("git config user.name 'github-actions[bot]'")
    expect(commitStep.run).not.toContain("user.name 'dependabot[bot]'")
  })
})
