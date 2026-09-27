import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards the release-PR token invariants in the release-prepare workflow. The workflow is
 * workflow_dispatch-only, so nothing on a normal PR exercises it; these assertions are the
 * only automated check that the PAT stays confined to the single step that needs it.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release-prepare.yml'), 'utf8')

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

  it('references the PAT in exactly one place', () => {
    // Earlier steps run npm install and the note generator (third-party code); the PAT must
    // not reach their environment or the checkout's persisted credentials.
    expect(workflow.match(/secrets\.RELEASE_PR_TOKEN/g)).toHaveLength(1)
    expect(workflow).not.toMatch(/token: \$\{\{ secrets\.RELEASE_PR_TOKEN/)
  })

  it('reads the PAT from the main-only release-pr environment', () => {
    const prepareJob = workflow.slice(workflow.indexOf('\n  prepare:'))
    expect(prepareJob).toMatch(/^ {4}environment: release-pr$/m)
  })
})
