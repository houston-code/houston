/**
 * The checked-in baselines under `baselines/`, checked on every PR.
 *
 * The live driver only runs on a schedule, so without this a PR that points the
 * schedule at a model with no baseline merges green and the next scheduled
 * `eval-live.yml` run reds with "No quality baseline recorded": days later, on nobody's
 * PR. The model is read from the workflow itself, so this stays pinned to what that
 * run will actually score.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { baselineFileName, isDeadBaseline, isEvalBaseline } from './baseline'

const BASELINES_DIR = fileURLToPath(new URL('./baselines', import.meta.url))
const WORKFLOW = fileURLToPath(new URL('../../../../.github/workflows/eval-live.yml', import.meta.url))

const load = (file: string): unknown => JSON.parse(readFileSync(join(BASELINES_DIR, file), 'utf8'))

describe('live eval baselines', () => {
  it('has a baseline for the model the scheduled run scores', () => {
    // With no `model` input (every scheduled run), eval-live.yml picks the Anthropic
    // model it names in its HOUSTON_EVAL_MODEL expression.
    const scheduled = /HOUSTON_EVAL_MODEL: \$\{\{ inputs\.model \|\|.*&& '([^']+)' \|\|/.exec(readFileSync(WORKFLOW, 'utf8'))
    expect(scheduled, 'eval-live.yml no longer names its scheduled model the way this test reads it').not.toBeNull()
    const model = scheduled![1]
    const file = baselineFileName('anthropic', model)
    expect(
      existsSync(join(BASELINES_DIR, file)),
      `No live eval baseline for "anthropic/${model}", the model eval-live.yml schedules. ` +
        `Record it in the same PR, or the next scheduled run fails:\n` +
        `  HOUSTON_EVAL_MODEL=${model} npm run eval:baseline`
    ).toBe(true)
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
  })
})
