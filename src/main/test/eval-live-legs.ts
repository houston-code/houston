import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

/**
 * The scheduled legs of eval-live.yml, read from the workflow itself, for the tests that
 * pin them: eval-live-workflow.test.ts (which also runs the resolve script for each leg,
 * so this reading is checked against what the runner does) and baselines.test.ts (which
 * requires a baseline for each). Reading the script's text rather than running it keeps
 * the baseline check working on Windows, where the bash tests are skipped.
 */

export const EVAL_LIVE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.github/workflows/eval-live.yml')

export interface ScheduledLeg {
  /** The cron under `on.schedule`, the string a scheduled run's `github.event.schedule` holds. */
  cron: string
  provider: string
  model: string
  /** The leg's HOUSTON_EVAL_MAX_RUN_USD, as the script writes it. */
  maxRunUsd: string
}

export interface EvalLive {
  source: string
  doc: any
}

export function loadEvalLive(): EvalLive {
  const source = readFileSync(EVAL_LIVE_PATH, 'utf8')
  return { source, doc: load(source) as any }
}

/** The resolve job's step: the one place a run's provider, model and cap are decided. */
export function resolveStep(doc: any): { env: Record<string, string>; run: string } {
  const step = (doc.jobs?.resolve?.steps ?? []).find((s: any) => s.id === 'leg')
  if (!step) throw new Error("eval-live.yml has no resolve job with a step `id: leg`")
  return step
}

/** One schedule arm of the resolve script, which the workflow keeps on one line each. */
const ARM = /^ *'([^']+)'\) provider=([\w.-]+) model=([\w.-]+) cap=(\d+(?:\.\d+)?) ;;$/gm

/** Every schedule arm in the resolve script, keyed by its cron. */
export function scheduleArms(doc: any): Map<string, Omit<ScheduledLeg, 'cron'>> {
  const arms = new Map<string, Omit<ScheduledLeg, 'cron'>>()
  for (const m of resolveStep(doc).run.matchAll(ARM)) {
    if (arms.has(m[1])) throw new Error(`eval-live.yml's resolve job has two arms for '${m[1]}'`)
    arms.set(m[1], { provider: m[2], model: m[3], maxRunUsd: m[4] })
  }
  return arms
}

/** The crons under `on.schedule`, in order. */
export function scheduledCrons(doc: any): string[] {
  // js-yaml reads a bare `on` key as true under YAML 1.1 rules.
  const triggers = doc.on ?? doc[true as unknown as string]
  return ((triggers?.schedule ?? []) as { cron: string }[]).map((s) => s.cron)
}

/**
 * Each cron under `on.schedule` with the leg the resolve script maps it to. Throws for a
 * cron with no arm (that run would fail at the resolve job) or one this can't read.
 */
export function scheduledLegs(doc: any = loadEvalLive().doc): ScheduledLeg[] {
  const arms = scheduleArms(doc)
  return scheduledCrons(doc).map((cron) => {
    const arm = arms.get(cron)
    if (!arm) {
      throw new Error(
        `eval-live.yml schedules '${cron}', and its resolve job has no arm for it in the form ` +
          `'<cron>') provider=<id> model=<id> cap=<usd> ;;`
      )
    }
    return { cron, ...arm }
  })
}
