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

// A crashed reviewer must not hide what the others found.
{
  const result = await reviewChanges(DIFF, {
    reviewers: [reviewer('correctness', {}, [1]), reviewer('security', { 1: [sqlInjection] })],
    verify: async () => true
  })
  assert.equal(
    formatReview(result),
    [
      'Review incomplete: 1 step failed, so this is not a clean bill of health.',
      '  ! correctness on chunk 1 (src/auth.mjs, src/db.mjs): model timed out',
      'src/db.mjs: query built by string concatenation (security)'
    ].join('\n')
  )
}

// A skeptic that errors has not refuted anything: the finding stays, flagged as
// unverified, and the review says a step failed.
{
  const result = await reviewChanges(DIFF, {
    reviewers: [reviewer('security', { 1: [sqlInjection] }), reviewer('correctness', { 1: [nullDeref] })],
    verify: async (f) => {
      if (f.id === 'f1') throw new Error('rate limited')
      return true
    }
  })
  assert.equal(result.status, 'incomplete')
  const kept = result.findings.find((f) => f.id === 'f1')
  assert.ok(kept, 'a finding whose check errored was dropped')
  assert.equal(kept.unverified, true)
  assert.equal(result.findings.find((f) => f.id === 'f2')?.unverified ?? false, false)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /rate limited/)
  const text = formatReview(result)
  assert.match(text, /^Review incomplete: 1 step failed/)
  assert.match(text, /query built by string concatenation \(security\) \[unverified\]/)
}
console.log('ok')
