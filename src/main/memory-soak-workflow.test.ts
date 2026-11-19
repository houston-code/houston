import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { evaluate, type Value } from './test/actions-expression'

/**
 * Guards memory-soak.yml's concurrency. Its nightly and weekly crons both run on main, and
 * one cancel-in-progress group for both let a delayed start of one cancel the other, with
 * no failure to report.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const doc = load(readFileSync(resolve(root, '.github/workflows/memory-soak.yml'), 'utf8')) as any
const crons: string[] = doc.on.schedule.map((s: { cron: string }) => s.cron)

const group = (github: Record<string, Value>): Value => evaluate(doc.concurrency.group, { contexts: { github } })
const scheduled = (cron: string) => group({ event_name: 'schedule', ref: 'refs/heads/main', event: { schedule: cron } })

describe('memory-soak.yml concurrency', () => {
  it('gives each scheduled run its own group, so one cron never cancels the other', () => {
    expect(crons.length).toBeGreaterThan(1)
    const groups = crons.map(scheduled)
    expect(new Set(groups).size).toBe(crons.length)
  })

  it('still lets a newer push to a pull request cancel the older run', () => {
    const pr = { event_name: 'pull_request', ref: 'refs/pull/7/merge', event: {} }
    expect(group(pr)).toBe(group(pr))
    expect(group(pr)).not.toBe(group({ ...pr, ref: 'refs/pull/8/merge' }))
    expect(doc.concurrency['cancel-in-progress']).toBe(true)
  })
})
