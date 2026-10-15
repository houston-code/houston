import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Repository-wide invariants over every GitHub Actions workflow. ci.yml's `workflow-lint` job
 * runs zizmor too, but these pin the choices that zizmor leaves to configuration.
 */
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows')
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith('.yml'))
  .map((name) => ({ name, text: readFileSync(resolve(dir, name), 'utf8') }))

/** Each `actions/checkout` step: from its `uses:` line up to the next step at that indent. */
function checkouts(text: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const m = /^(\s*)- uses: actions\/checkout@/.exec(line)
    if (!m) return
    const step = [line]
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.trim() !== '' && l.length - l.trimStart().length <= m[1].length) break
      step.push(l)
    }
    out.push(step.join('\n'))
  })
  return out
}

describe('workflow hardening', () => {
  it('finds the workflows', () => {
    expect(workflows.map((w) => w.name)).toContain('ci.yml')
  })

  it('drops the checkout credential unless the job pushes with it', () => {
    // A persisted token sits in .git/config for every later step, including `npm ci`
    // lifecycle scripts. The two jobs that push (the release branch, the release tag) say so.
    for (const { name, text } of workflows) {
      for (const step of checkouts(text)) {
        const pushes = step.includes('zizmor: ignore[artipacked]')
        if (pushes) expect(step, name).toMatch(/token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
        else expect(step, name).toContain('persist-credentials: false')
      }
    }
  })

  it('pins every runner image instead of following a moving -latest label', () => {
    // Comments may still explain why a leg is NOT on -latest.
    for (const { name, text } of workflows) {
      const code = text
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n')
      expect(code, name).not.toMatch(/\b(ubuntu|macos|windows)-latest\b/)
    }
  })

  it('never grants id-token: write to a whole workflow', () => {
    // Only a job that signs needs to mint an OIDC token; at the top level every job,
    // including called workflows, would get it.
    for (const { name, text } of workflows) {
      const top = text.slice(0, text.indexOf('\njobs:'))
      expect(top, name).not.toContain('id-token: write')
    }
  })

  it('sets up Node only through the shared composite action', () => {
    // One place for the Node version source, cache policy and npm ci flags.
    for (const { name, text } of workflows) {
      expect(text, name).not.toMatch(/uses: actions\/setup-node@/)
    }
  })

  it('generates the lockfile SBOMs only through the shared composite action', () => {
    // sbom.yml, the conformance gate and the release must describe the same closure.
    for (const { name, text } of workflows) {
      expect(text, name).not.toMatch(/^\s*syft scan file:/m)
    }
  })
})
