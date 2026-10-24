import assert from 'node:assert/strict'
import { formatReview } from './review/format.mjs'
import { reviewChanges } from './review/run.mjs'

const DIFF = ['src/auth.mjs', 'src/db.mjs', 'src/routes.mjs']
  .map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new`)
  .join('\n')

/** A reviewer that reports `findings[chunkIndex]` and throws on the chunks in `failOn`. */
function reviewer(name, findings = {}, failOn = []) {
  return {
    name,
    async review(chunk) {
      if (failOn.includes(chunk.index)) throw new Error('model timed out')
      return findings[chunk.index] ?? []
    }
  }
}
const sqlInjection = { id: 'f1', file: 'src/db.mjs', message: 'query built by string concatenation' }
const nullDeref = { id: 'f2', file: 'src/auth.mjs', message: 'user may be undefined' }
const styleNit = { id: 'f3', file: 'src/routes.mjs', message: 'prefer const' }

// Everything works: the skeptic confirms two findings and refutes the nit.
{
  const result = await reviewChanges(DIFF, {
    reviewers: [reviewer('correctness', { 1: [nullDeref], 2: [styleNit] }), reviewer('security', { 1: [sqlInjection] })],
    verify: async (f) => f.id !== 'f3'
  })
  assert.equal(
    formatReview(result),
    'src/auth.mjs: user may be undefined (correctness)\nsrc/db.mjs: query built by string concatenation (security)'
  )
}

// A clean review really is clean.
{
  const result = await reviewChanges(DIFF, { reviewers: [reviewer('correctness')], verify: async () => true })
  assert.equal(formatReview(result), 'No issues found.')
}

// The reported bug: a reviewer crashed, and the run printed "No issues found."
{
  const result = await reviewChanges(DIFF, {
    reviewers: [reviewer('correctness'), reviewer('security', {}, [2])],
    verify: async () => true
  })
  assert.equal(result.status, 'incomplete')
  assert.equal(
    formatReview(result),
    'Review incomplete: 1 step failed, so this is not a clean bill of health.\n  ! security on chunk 2 (src/routes.mjs): model timed out'
  )
}

console.log('ok')
