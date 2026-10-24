/**
 * The prompt hash stamped on every eval run, its baseline, and its run record.
 *
 * WHY. A score is only comparable to another score when you know what produced
 * each one. The model id and the attempt count were always recorded; the prompt
 * the model actually saw was not, so a baseline recorded in July and a run in
 * October could differ by a dozen prompt edits with nothing in either file
 * saying so. The hash is that missing label: same hash, same prompt and tools.
 *
 * WHAT IT COVERS. The system prompt and the tool schemas of the run's FIRST model
 * request, as the provider received them. Later requests can legitimately differ
 * (find_tools loads more tools mid-run), and the first one is what every attempt
 * shares.
 *
 * WHAT IT NORMALIZES. Only what changes between two runs of the same prompt: the
 * throwaway workspace path every task gets, and calendar dates (the prompt states
 * today's date). It deliberately does NOT normalize the host lines (OS, shell,
 * sandbox), because a model really is told something different on Linux than on
 * macOS. So compare hashes from the same kind of host; the run record names it.
 */
import { createHash } from 'node:crypto'
import type { ChatRequest } from '@shared/agent'

/** ISO calendar dates, e.g. the prompt's "Today's date: 2026-10-24." line. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g

/**
 * JSON with object keys sorted at every level, so key order can't move the hash,
 * and every string passed through `scrub` BEFORE serializing: a Windows path is
 * escaped in JSON (`C:\\Users`), so scrubbing the serialized text would miss it.
 */
function stableJson(v: unknown, scrub: (s: string) => string): string {
  const walk = (val: unknown): unknown => {
    if (typeof val === 'string') return scrub(val)
    if (Array.isArray(val)) return val.map(walk)
    if (val && typeof val === 'object') {
      return Object.fromEntries(
        Object.entries(val as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, walk(x)])
      )
    }
    return val
  }
  return JSON.stringify(walk(v))
}

/**
 * A 12-hex hash of a request's system prompt and tools.
 *
 * `workspaces` lists every spelling of the run's workspace path (on macOS the temp
 * dir is reached through a /var -> /private/var symlink, and the prompt may carry
 * either), longest first so a shorter spelling can't split a longer one.
 */
export function promptHash(req: Pick<ChatRequest, 'system' | 'tools'>, workspaces: string[]): string {
  const paths = [...new Set(workspaces.filter(Boolean))].sort((a, b) => b.length - a.length)
  const scrub = (s: string): string =>
    paths.reduce((acc, p) => acc.split(p).join('<workspace>'), s).replace(ISO_DATE, '<date>')
  const material = `${scrub(req.system ?? '')}\n${stableJson(req.tools ?? [], scrub)}`
  return createHash('sha256').update(material).digest('hex').slice(0, 12)
}

/**
 * The one hash a set of attempts shares, or undefined when there is none.
 *
 * More than one distinct hash inside a single run means the normalization above
 * missed something machine- or task-specific, and a "prompt hash" that varies by
 * task would label nothing. Reporting none is better than reporting one of them.
 */
export function sharedHash(hashes: (string | undefined)[]): string | undefined {
  const distinct = new Set(hashes)
  if (distinct.size !== 1) return undefined
  return [...distinct][0]
}
