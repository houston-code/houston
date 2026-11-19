/**
 * The checked-in baselines under `baselines/`, checked on every PR.
 *
 * The live driver only runs on a schedule, so without this a PR that points a
 * scheduled leg at a model with no baseline merges green and that leg's next
 * `eval-live.yml` run reds with "No quality baseline recorded": days or months later,
 * on nobody's PR. The legs are read from the workflow itself, so this stays pinned to
 * what each scheduled run will actually score.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultProviders } from '@shared/defaults'
import {
  assertRecordable,
  baselineFileName,
  compareAggregate,
  compareToBaseline,
  isDeadBaseline,
  isEvalBaseline,
  regressions
} from './baseline'
import { resolveEvalConfig, selectTasks } from './config'
import { PROBES } from './probes'
import { HARD_TASKS, TASKS } from './tasks'
import { isProbeResultId, probeResultId } from './types'
import { EVAL_LIVE_PATH as WORKFLOW, scheduledLegs } from '../../test/eval-live-legs'

const BASELINES_DIR = fileURLToPath(new URL('./baselines', import.meta.url))
/** Every scheduled leg of eval-live.yml: its cron, provider, model and run cap. */
const LEGS = scheduledLegs()

const load = (file: string): unknown => JSON.parse(readFileSync(join(BASELINES_DIR, file), 'utf8'))

describe('live eval baselines', () => {
  it('records only when a dispatch asks to, and uploads the result instead of pushing it', () => {
    const text = readFileSync(WORKFLOW, 'utf8')
    // Empty on a scheduled run, which the suite treats as unset: the schedule always grades.
    expect(text).toContain("HOUSTON_EVAL_RECORD: ${{ inputs.record && '1' || '' }}")
    expect(text).toContain('name: eval-baseline')
    // The baseline is collected and uploaded even when the scoring step failed, so a task
    // overrunning its time limit after it was scored does not lose the recording.
    expect(text.match(/if: \$\{\{ !cancelled\(\) && inputs\.record \}\}/g)).toHaveLength(2)
    expect(text).not.toContain('if: ${{ inputs.record }}')
    expect(text).not.toMatch(/contents: write|git push/)
  })

  it('gives every run the key of the provider it scores', () => {
    // A run dispatched with another provider once had only the Anthropic key in scope. The
    // provider is the resolve job's, so a scheduled leg on openai or gemini gets that
    // provider's key too, in both steps that read one.
    const text = readFileSync(WORKFLOW, 'utf8')
    for (const [provider, secret] of [
      ['anthropic', 'ANTHROPIC_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
      ['gemini', 'GEMINI_API_KEY']
    ]) {
      expect(text.split(`needs.resolve.outputs.provider == '${provider}' && secrets.${secret}`)).toHaveLength(3)
      expect(text).toContain(`${provider}) key_name=${secret} ;;`)
    }
    expect(text).not.toMatch(/inputs\.provider[^\n]*&& secrets\./)
    // No key is set for the whole job: each is scoped to the step that uses it.
    expect(text).not.toMatch(/^ {4}env:\n(?: {6}.*\n)*? {6}\w*API_KEY/m)
  })

  it('reads every scheduled leg from the workflow', () => {
    // scheduledLegs throws for a cron with no leg; an empty list would pass the checks below
    // vacuously. eval-live-workflow.test.ts pins which legs these are.
    expect(LEGS.length).toBeGreaterThan(0)
    expect(new Set(LEGS.map((l) => `${l.provider}/${l.model}`)).size).toBe(LEGS.length)
  })

  // A scheduled run has no inputs: its cron picks the provider and model, in the resolve job.
  it.each(LEGS)('has a live baseline for the leg scheduled at "$cron" ($provider/$model)', ({ cron, provider, model }) => {
    const file = baselineFileName(provider, model)
    expect(
      existsSync(join(BASELINES_DIR, file)),
      `No live eval baseline for "${provider}/${model}", which eval-live.yml schedules at '${cron}'. ` +
        `Record it in the same PR, or that leg's next scheduled run fails:\n` +
        `  HOUSTON_EVAL_PROVIDER=${provider} HOUSTON_EVAL_MODEL=${model} npm run eval:baseline`
    ).toBe(true)
    // Present but dead (every task 0) would let that leg pass forever while guarding nothing.
    const b = load(file)
    expect(isEvalBaseline(b), `${file} is malformed: re-record it`).toBe(true)
    if (!isEvalBaseline(b)) return
    expect([b.provider, b.model]).toEqual([provider, model])
    expect(isDeadBaseline(b), `${file} scores every task 0, so that leg can never regress`).toBe(false)
    // A task the baseline lacks is never graded on that leg: a recording that dropped
    // one, or a task added without re-recording, would go unguarded.
    expect(
      TASKS.map((t) => t.id).filter((id) => !(id in b.tasks)),
      `${file} has no score for these registered tasks, so that leg never grades them. Re-record it.`
    ).toEqual([])
  })

  const files = readdirSync(BASELINES_DIR).filter((f) => f.endsWith('.json'))

  it.each(files)('%s is a well-formed, live gate for the model its name says', (file) => {
    const b = load(file)
    expect(isEvalBaseline(b), 'malformed: re-record it with npm run eval:baseline').toBe(true)
    if (!isEvalBaseline(b)) return
    // A renamed or hand-copied file would be loaded for the wrong model.
    expect(baselineFileName(b.provider, b.model)).toBe(file)
    expect(isDeadBaseline(b), 'every task is 0, so nothing can ever regress').toBe(false)
    expect(Object.keys(b.tasks).length).toBeGreaterThan(0)
    // Probes are an A/B instrument and never baselined.
    expect(Object.keys(b.tasks).filter(isProbeResultId), 'a behavior probe was recorded').toEqual([])
  })
})

/**
 * A live run of the probes (HOUSTON_EVAL_TASKS=probes) loads the model's baseline like
 * any live run, and then must grade nothing against it: every probe row is
 * `unrecorded`, the whole-run check has nothing to compare, and a run that solved no
 * probe at all still passes. No agent shell has a key to run it live, so this walks the
 * same calls the driver makes, against the baseline each scheduled leg loads.
 */
describe.each(LEGS)('a live run of the behavior probes on $provider/$model', ({ provider, model }) => {
  const env = { HOUSTON_EVAL_LIVE: '1', HOUSTON_EVAL_PROVIDER: provider, HOUSTON_EVAL_MODEL: model, HOUSTON_EVAL_TASKS: 'probes' }

  it('selects every probe and no task, and refuses to record them', () => {
    const config = resolveEvalConfig(env, defaultProviders())
    expect([config.providerId, config.model]).toEqual([provider, model])
    expect(selectTasks(TASKS, HARD_TASKS, config.tasks, PROBES)).toEqual({ tasks: [], probes: PROBES })
    expect(() => resolveEvalConfig({ ...env, HOUSTON_EVAL_RECORD: '1' }, defaultProviders())).toThrow(/records every task/)
  })

  it('reports every probe unrecorded against the baseline, and never fails the gate', () => {
    const baseline = load(baselineFileName(provider, model))
    if (!isEvalBaseline(baseline)) throw new Error('the scheduled model has no well-formed baseline')
    // The worst case: no probe passed a single attempt.
    const probes = PROBES.map((p) => ({ taskId: probeResultId(p.id), passRate: 0, attempts: baseline.attempts }))
    const verdicts = compareToBaseline(baseline, probes)
    expect(verdicts.map((v) => v.kind)).toEqual(PROBES.map(() => 'unrecorded'))
    expect(regressions(verdicts)).toEqual([])
    expect(compareAggregate(baseline, probes), 'nothing for the whole-run check to grade').toBeUndefined()

    // Beside tasks, the probes change nothing about how the tasks are graded.
    const tasks = Object.entries(baseline.tasks).map(([taskId, passRate]) => ({ taskId, passRate, attempts: baseline.attempts }))
    expect(compareAggregate(baseline, [...tasks, ...probes])).toEqual(compareAggregate(baseline, tasks))
    expect(() => assertRecordable([...tasks, ...probes])).toThrow(/behavior probes/)
  })
})
