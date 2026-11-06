import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

/**
 * Guards ci-heal.yml, which re-runs a PR's CI when the newest run on its head commit was
 * cancelled (scripts/heal-cancelled-ci.mjs). It holds `actions: write`, so these pin that
 * it runs only trusted code from the default branch and can do nothing beyond a re-run.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const source = readFileSync(resolve(root, '.github/workflows/ci-heal.yml'), 'utf8')
const doc = load(source) as any
const triggers = doc.on ?? doc[true as unknown as string]
const heal = doc.jobs.heal
const steps = heal.steps as any[]

describe('CI heal workflow', () => {
  it('runs on a schedule (and by hand), never on a PR event', () => {
    // A schedule runs main's code with a writable token. A PR trigger would run the PR's
    // tree, and a Dependabot-triggered workflow_run gets a read-only token that cannot re-run.
    expect(Object.keys(triggers).sort()).toEqual(['schedule', 'workflow_dispatch'])
    expect(triggers.schedule[0].cron).toBe('*/15 * * * *')
  })

  it('grants only what a re-run needs', () => {
    expect(doc.permissions).toEqual({ contents: 'read' })
    expect(heal.permissions).toEqual({ contents: 'read', 'pull-requests': 'read', actions: 'write' })
  })

  it('checks out the default branch without persisting credentials, and installs nothing', () => {
    const checkout = steps.find((s) => String(s.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout.with).toEqual({ 'persist-credentials': false })
    for (const step of steps) expect(String(step.run ?? '')).not.toMatch(/\bnpm\b/)
  })

  it('runs the tested script with the workflow token, and no secrets', () => {
    const run = steps.find((s) => s.run)
    expect(run.run).toBe('node scripts/heal-cancelled-ci.mjs')
    expect(run.env.GH_TOKEN).toBe('${{ github.token }}')
    expect(source).not.toContain('secrets.')
  })

  it('pins every action to a commit SHA', () => {
    for (const step of steps) if (step.uses?.startsWith('actions/')) expect(step.uses).toMatch(/@[0-9a-f]{40}$/)
  })

  it('alerts when a scheduled run fails, since nobody else is told', () => {
    expect(doc.jobs.alert.uses).toBe('./.github/workflows/alert-on-failure.yml')
    expect(doc.jobs.alert.permissions).toEqual({ issues: 'write' })
  })
})
