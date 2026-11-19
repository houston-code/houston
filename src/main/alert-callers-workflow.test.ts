import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { evaluate, evaluateIf, type Value } from './test/actions-expression'

/**
 * What each caller of the shared alert (alert-on-failure.yml) reports for the ways its jobs
 * can end. The case that motivated this: a matrix job with a leg GitHub never gave a runner
 * reports `abandoned`, not `failure`, so a caller checking only for `failure` told the alert
 * the run was green while the run itself ended red, and nobody heard about it.
 *
 * eval-live.yml is left out: it reports per leg with its own rules, which
 * eval-live-workflow.test.ts covers.
 */
const workflows = resolve(dirname(fileURLToPath(import.meta.url)), '../../.github/workflows')

const callers = readdirSync(workflows)
  .filter((f) => f.endsWith('.yml') && f !== 'eval-live.yml')
  .flatMap((file) => {
    const doc = load(readFileSync(resolve(workflows, file), 'utf8')) as any
    return Object.entries(doc.jobs as Record<string, any>)
      .filter(([, job]) => job.uses === './.github/workflows/alert-on-failure.yml')
      .map(([name, job]) => ({ label: `${file} ${name}`, job }))
  })

/** The alert's `if:` and `failed` input for a run whose `needs` ended with these results. */
function report(job: any, results: string[]): { runs: boolean; failed: Value } {
  const needs = Object.fromEntries(results.map((result, i) => [`job${i}`, { result }]))
  const event_name = String(job.if).includes("'schedule'") ? 'schedule' : 'push'
  const ctx = { contexts: { needs, github: { event_name }, inputs: {} } }
  return { runs: evaluateIf(job.if, ctx), failed: evaluate(job.with.failed, ctx) }
}

describe('callers of the shared alert', () => {
  it('finds every caller', () => {
    expect(callers.map((c) => c.label).sort()).toEqual([
      'ci-heal.yml alert',
      'ci.yml alert',
      'dependabot-digest.yml alert',
      'memory-soak.yml alert',
      'model-drift.yml alert',
      'native-vuln-scan.yml alert',
      'provider-canary.yml alert',
    ])
  })

  describe.each(callers)('$label', ({ job }) => {
    it('reports green when every job succeeded or was skipped', () => {
      expect(report(job, ['success', 'skipped'])).toEqual({ runs: true, failed: false })
    })

    it('reports failed when a job failed', () => {
      expect(report(job, ['success', 'failure'])).toEqual({ runs: true, failed: true })
    })

    it('reports failed when a matrix leg never got a runner (`abandoned`)', () => {
      expect(report(job, ['success', 'abandoned', 'skipped'])).toEqual({ runs: true, failed: true })
    })

    it('stays out of a cancelled run, which is neither red nor green', () => {
      expect(report(job, ['success', 'cancelled']).runs).toBe(false)
    })
  })
})
