/**
 * The checked-in baselines under `baselines/`, checked on every PR.
 *
 * The live driver only runs on a schedule, so without this a PR that changes the
 * Anthropic `defaultModel` merges green and the next scheduled `eval-live.yml` run
 * reds with "No quality baseline recorded" — days later, on nobody's PR. Resolving
 * the model through the same `resolveEvalConfig` the scheduled run uses keeps this
 * pinned to what that run will actually score.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defaultProviders } from '@shared/defaults'
import { baselineFileName, isDeadBaseline, isEvalBaseline } from './baseline'
import { resolveEvalConfig } from './config'

const BASELINES_DIR = fileURLToPath(new URL('./baselines', import.meta.url))

const load = (file: string): unknown => JSON.parse(readFileSync(join(BASELINES_DIR, file), 'utf8'))

describe('live eval baselines', () => {
  it('has a baseline for the model the scheduled run scores', () => {
    // A scheduled run has no dispatch inputs, so it resolves the provider default.
    const { providerId, model } = resolveEvalConfig({ HOUSTON_EVAL_LIVE: '1' }, defaultProviders())
    const file = baselineFileName(providerId, model)
    expect(
      existsSync(join(BASELINES_DIR, file)),
      `No live eval baseline for the default model "${providerId}/${model}". ` +
        `Changing defaultModel needs one in the same PR, or the scheduled eval-live.yml run fails. Record it with:\n` +
        `  HOUSTON_EVAL_PROVIDER=${providerId} HOUSTON_EVAL_MODEL=${model} npm run eval:baseline`
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
