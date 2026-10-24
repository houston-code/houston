import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Pins the security shape of the GitHub Action in action/: the composite action itself,
 * the example workflows users copy, and the action's own end-to-end workflow. zizmor (in
 * ci.yml's workflow-lint job) audits the same files; these pin the choices it leaves open.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (p: string): string => readFileSync(resolve(root, p), 'utf8')
const action = read('action/action.yml')
const examples = readdirSync(resolve(root, 'action/examples'))
  .filter((f) => f.endsWith('.yml'))
  .map((name) => ({ name, text: read(`action/examples/${name}`) }))
const e2e = read('.github/workflows/action-test.yml')

/** The body of every `run:` step (single line or block). */
function runScripts(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(line)
    if (!m) return
    const body = [m[2]]
    if (m[2] === '|' || m[2] === '>-' || m[2] === '>') {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]
        if (l.trim() !== '' && l.length - l.trimStart().length <= m[1].length) break
        body.push(l)
      }
    }
    out.push(body.join('\n'))
  })
  return out
}

/** The step (from its `- ` line to the next step at that indent) containing `needle`. */
function stepWith(text: string, needle: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((l) => l.includes(needle))
  let start = at
  while (start > 0 && !/^\s*- /.test(lines[start])) start--
  const indent = lines[start].length - lines[start].trimStart().length
  let end = start + 1
  while (end < lines.length && !(lines[end].trim() !== '' && lines[end].length - lines[end].trimStart().length <= indent)) end++
  return lines.slice(start, end).join('\n')
}

describe('the composite action', () => {
  it('is a composite action exposing the documented inputs', () => {
    expect(action).toMatch(/^runs:\n {2}using: composite$/m)
    for (const input of [
      'mode',
      'prompt',
      'provider',
      'model',
      'api-key',
      'approval',
      'max-turns',
      'max-cost',
      'verify',
      'allowed-tools',
      'cli-version',
      'github-token'
    ]) {
      expect(action, input).toMatch(new RegExp(`^ {2}${input}:$`, 'm'))
    }
  })

  it('pins every action it uses to a full commit SHA, Node to the repo-wide one', () => {
    const uses = [...action.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40}$/)
    const shared = /uses: (actions\/setup-node@[0-9a-f]{40})/.exec(read('.github/actions/setup-node/action.yml'))?.[1]
    expect(uses).toContain(shared)
  })

  it('passes inputs to its scripts only through the environment', () => {
    for (const script of runScripts(action)) expect(script).not.toContain('${{')
    // The key reaches exactly one step, as an env var.
    expect(action.match(/inputs\.api-key/g)).toHaveLength(1)
    expect(action).toContain('HOUSTON_ACTION_API_KEY: ${{ inputs.api-key }}')
  })

  it('installs the CLI before running it, through the verifying script', () => {
    expect(action.indexOf('scripts/install.mjs')).toBeGreaterThan(0)
    expect(action.indexOf('scripts/install.mjs')).toBeLessThan(action.indexOf('scripts/run.mjs'))
    expect(action).toContain('HOUSTON_CLI_PATH: ${{ steps.install.outputs.cli-path }}')
  })
})

describe('the example workflows', () => {
  it('covers each mode', () => {
    expect(examples.map((e) => e.name).sort()).toEqual(['houston-fix-ci.yml', 'houston-respond.yml', 'houston-review.yml'])
  })

  it.each(examples)('$name starts with no permissions and grants each job its own', ({ text }) => {
    expect(text).toMatch(/^permissions: \{\}$/m)
    const jobs = text.slice(text.indexOf('\njobs:'))
    expect(jobs).toMatch(/^ {4}permissions:$/m)
    expect(jobs).not.toMatch(/: write-all|id-token: write/)
  })

  it.each(examples)('$name never uses pull_request_target', ({ text }) => {
    // Comments may explain why not.
    const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')
    expect(code).not.toContain('pull_request_target')
  })

  it.each(examples)('$name drops the checkout credential and interpolates nothing into a shell', ({ text }) => {
    expect(stepWith(text, 'actions/checkout@')).toContain('persist-credentials: false')
    expect(text).toMatch(/actions\/checkout@[0-9a-f]{40} # v/)
    for (const script of runScripts(text)) expect(script).not.toContain('${{')
  })

  it.each(examples)('$name pins its runner and bounds its run time', ({ text }) => {
    expect(text).not.toMatch(/-latest\b/)
    expect(text).toMatch(/timeout-minutes: \d+/)
  })

  it('reviews only same-repository pull requests', () => {
    const review = examples.find((e) => e.name === 'houston-review.yml')!.text
    expect(review).toContain('github.event.pull_request.head.repo.full_name == github.repository')
    expect(review).toContain('fetch-depth: 0')
    expect(review).toMatch(/pull-requests: write/)
    expect(review).not.toMatch(/contents: write/)
  })

  it('answers mentions from the default branch, never a pull request head', () => {
    const respond = examples.find((e) => e.name === 'houston-respond.yml')!.text
    expect(stepWith(respond, 'actions/checkout@')).not.toContain('ref:')
    expect(respond).not.toMatch(/contents: write/)
  })

  it('fixes CI only for same-repository runs, checked out at the failed commit', () => {
    const fix = examples.find((e) => e.name === 'houston-fix-ci.yml')!.text
    expect(fix).toContain('github.event.workflow_run.head_repository.full_name == github.repository')
    expect(fix).toContain("github.event.workflow_run.conclusion == 'failure'")
    expect(stepWith(fix, 'actions/checkout@')).toContain('ref: ${{ github.event.workflow_run.head_sha }}')
    expect(fix).toMatch(/actions: read/)
  })
})

describe('the action end-to-end workflow', () => {
  it('runs from CI (which gates it through `build`), with a read-only token and no secrets', () => {
    // ci.yml decides when it runs (scripts/ci-plan.mjs) and requires it; a pull_request
    // trigger of its own would report a check that gates nothing.
    expect(e2e).toMatch(/^on:\n {2}workflow_call:\n/m)
    expect(e2e).not.toMatch(/^ {2}pull_request:/m)
    expect(e2e).toContain('ref: ${{ inputs.ref || github.sha }}')
    expect(e2e).toMatch(/^permissions:\n {2}contents: read$/m)
    expect(e2e).not.toContain('secrets.')
    expect(e2e).not.toContain('pull_request_target')
  })

  it('drives the real composite action through every mode, posting nothing for real', () => {
    expect(e2e.match(/uses: \.\/action$/gm)?.length).toBeGreaterThanOrEqual(4)
    for (const mode of ['respond', 'respond-stranger', 'review', 'fix-ci']) {
      expect(e2e).toContain(`node action/test/assert.mjs ${mode} "$FIXTURE"`)
    }
    expect(e2e).toContain('action/test/bin" >> "$GITHUB_PATH"')
    expect(stepWith(e2e, 'mode: fix-ci')).toContain("post: 'false'")
  })
})
