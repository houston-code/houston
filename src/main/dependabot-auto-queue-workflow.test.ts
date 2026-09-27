import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * Guards the workflow that turns on auto-merge (i.e. merge-queue entry) for Dependabot's
 * patch and minor updates. It holds a token that can enable auto-merge, so what keeps it
 * safe is structural: it acts only on Dependabot's own PRs, and it never checks out or
 * runs the PR's code. These tests pin those properties so neither can be edited away.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/dependabot-auto-queue.yml'), 'utf8')

const doc = load(source) as any
// YAML 1.1 resolves a bare `on` key to boolean true; 1.2 keeps it a string.
const triggers = doc.on ?? doc[true as unknown as string]
const job = doc.jobs['auto-queue']
const steps = job.steps as any[]
const queueStep = steps.find((s) => String(s.run ?? '').includes('gh pr merge'))

describe('Dependabot auto-queue workflow acts only on Dependabot PRs', () => {
  it('triggers on pull requests, never pull_request_target', () => {
    // pull_request_target runs with a write token on fork PRs; this workflow has no reason
    // to see a fork's PR at all.
    expect(triggers).toHaveProperty('pull_request')
    expect(triggers).not.toHaveProperty('pull_request_target')
  })

  it('requires both the PR author and the actor to be Dependabot', () => {
    // Author alone would still fire after a human pushed to a Dependabot branch; actor
    // alone would fire when Dependabot rebases a PR someone else opened.
    expect(job.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'")
    expect(job.if).toContain("github.actor == 'dependabot[bot]'")
    expect(job.if).toContain('&&')
  })
})

describe('Dependabot auto-queue workflow runs no PR code', () => {
  it('never checks out the repository or installs dependencies', () => {
    // THE load-bearing assertion. With a write token in the run, executing the PR's tree
    // (a lifecycle script from a newly bumped package) is the one way that token leaks.
    // Checked against the steps, not the file: the header comment names `npm ci` to
    // explain what the retired auto-merge job got wrong.
    for (const step of steps) {
      expect(String(step.uses ?? '')).not.toMatch(/^actions\/checkout@/)
      expect(String(step.run ?? '')).not.toMatch(/\b(npm|npx|node|yarn|pnpm)\b/)
    }
  })

  it('pins every action to a commit SHA', () => {
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
    }
  })

  it('keeps the workflow token read-only everywhere', () => {
    // The write credential is NOTICES_PAT, scoped to the queue step. The ambient token
    // only reads the PR for Dependabot's metadata action.
    expect(doc.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' })
  })

  it('exposes the PAT to the queue step only', () => {
    for (const step of steps) {
      if (step === queueStep) continue
      expect(JSON.stringify(step)).not.toContain('secrets.')
    }
    expect(JSON.stringify(job.env ?? {})).not.toContain('secrets.')
  })
})

describe('Dependabot auto-queue workflow queues only what it should', () => {
  it('enables auto-merge rather than merging directly', () => {
    // --auto hands the PR to the merge queue once its required checks pass. A plain
    // `gh pr merge` would try to land it outright.
    expect(queueStep.run).toContain('gh pr merge --auto --merge')
  })

  it('enables auto-merge with a PAT, never GITHUB_TOKEN', () => {
    // Auto-merge enabled as github-actions[bot] is never acted on by the merge queue, and
    // a queue entry it did create would get no merge_group CI run. See the header.
    expect(queueStep.env.GH_TOKEN).toBe('${{ secrets.NOTICES_PAT }}')
    expect(source).not.toMatch(/github\.token|secrets\.GITHUB_TOKEN/)
  })

  it('fails loudly when the PAT is missing', () => {
    expect(queueStep.run).toMatch(/if \[ -z "\$\{GH_TOKEN\}" \]; then[\s\S]*exit 1/)
  })

  it('queues patch and minor updates only', () => {
    expect(queueStep.if).toContain("'version-update:semver-patch'")
    expect(queueStep.if).toContain("'version-update:semver-minor'")
    expect(queueStep.if).not.toContain('semver-major')
  })

  it('passes event data through env, never interpolated into the script', () => {
    // `${{ }}` inside `run:` is substituted before the shell parses it, so a crafted
    // value becomes shell syntax. Env vars arrive as plain data.
    for (const step of steps) {
      if (step.run) expect(step.run).not.toContain('${{')
    }
  })
})
