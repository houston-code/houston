/**
 * `npm run eval:compare`: the paired A/B scorecard between two run records.
 *
 *   HOUSTON_EVAL_A=a.json HOUSTON_EVAL_B=b.json npm run eval:compare
 *
 * Each record comes from an eval run with `HOUSTON_EVAL_OUT=<file>` (see
 * runRecord.ts for the workflow and why the comparison is per task). It lives in
 * the evals project so it runs with the same TypeScript setup as the suite, and
 * it is skipped when the two files aren't named, so `npm run eval` passes over it.
 *
 * It prints, it does not gate: a comparison is a question someone asked, and the
 * answer (including "no significant difference") is the output.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { envOr } from './config'
import { compareRuns, formatComparison, isRunRecord, type EvalRunRecord } from './runRecord'

const A = envOr(process.env, 'HOUSTON_EVAL_A', '')
const B = envOr(process.env, 'HOUSTON_EVAL_B', '')

function load(file: string): EvalRunRecord {
  const path = resolve(file)
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!isRunRecord(parsed)) {
    throw new Error(`${path} is not an eval run record. Write one with HOUSTON_EVAL_OUT=<file> npm run eval.`)
  }
  return parsed
}

describe.runIf(A !== '' || B !== '')('eval A/B comparison', () => {
  it('compares run B against run A', () => {
    expect(A && B, 'Name both runs: HOUSTON_EVAL_A=<file> HOUSTON_EVAL_B=<file> npm run eval:compare').toBeTruthy()
    const a = load(A)
    const b = load(B)
    console.log(formatComparison(compareRuns(a, b), a, b, { a: basename(A), b: basename(B) }))
  })
})
