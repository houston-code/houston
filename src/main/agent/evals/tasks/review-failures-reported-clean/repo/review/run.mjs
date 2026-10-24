import { splitDiff } from './chunks.mjs'
import { summarize } from './summary.mjs'

/**
 * Adversarial review: every reviewer (one per dimension: correctness, security, ...)
 * reads every chunk and proposes findings, then a skeptic tries to refute each one.
 * Only findings the skeptic confirms are reported, which keeps the false positives
 * down.
 *
 * reviewers: [{ name, review(chunk) -> Promise<[{ id, file, message }]> }]
 * verify(finding) -> Promise<boolean>   true = the skeptic confirmed it
 */
export async function reviewChanges(diff, { reviewers, verify }) {
  const chunks = splitDiff(diff)
  const jobs = chunks.flatMap((chunk) =>
    reviewers.map((r) =>
      r.review(chunk).then((found) => found.map((f) => ({ ...f, reviewer: r.name, chunk: chunk.index })))
    )
  )
  const settled = await Promise.allSettled(jobs)
  const candidates = settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value)

  const confirmed = []
  for (const finding of candidates) {
    let ok
    try {
      ok = await verify(finding)
    } catch {
      ok = false
    }
    if (ok) confirmed.push(finding)
  }
  return summarize(confirmed)
}
