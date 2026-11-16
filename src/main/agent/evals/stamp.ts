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
 * What eval-ab.yml compares across a pull request to decide whether a live A/B can
 * show anything: the first request's {@link promptHash} folded with the loop's
 * `promptId`. Each misses something the other sees. The first request carries the
 * full system prompt but names deferred tools (memory_save, wait_for and the rest)
 * only by a catalog line, so a change to one of their schemas leaves its hash alone;
 * `promptId` covers every built-in schema but leaves out the parts of the prompt the
 * project supplies, built-in skills' index lines among them.
 */
export function abGateHash(firstRequestHash: string, runPromptId: string): string {
  return createHash('sha256').update(`${firstRequestHash}\0${runPromptId}`).digest('hex').slice(0, 12)
}

/**
 * The one hash a set of attempts shares, or undefined when there is none.
 *
 * More than one distinct hash inside a single run means the normalization above
 * missed something machine- or task-specific, and a "prompt hash" that varies by
 * task would label nothing. Reporting none is better than reporting one of them.
 * An attempt with no hash at all (it made no model request) leaves none too; see
 * {@link hashCensus} for telling the two apart.
 */
export function sharedHash(hashes: (string | undefined)[]): string | undefined {
  const distinct = new Set(hashes)
  if (distinct.size !== 1) return undefined
  return [...distinct][0]
}

/**
 * The loop promptId a run's attempts share, taken from the attempts that report one:
 * undefined when none does, or when those that do disagree.
 *
 * A missing id is not the signal a missing hash is. The loop stamps its promptId on the
 * replies it saves, so an attempt whose first request failed (a refusal, an overload, no
 * credit left) has a prompt hash but no promptId, and {@link sharedHash} over every
 * attempt would leave the whole run's record without one, read in a comparison as a
 * record from before the stamp existed.
 */
export function sharedPromptId(ids: (string | undefined)[]): string | undefined {
  return sharedHash(ids.filter((id): id is string => id !== undefined))
}

/** What a run's attempts said about their prompt hash, for when they share none. */
export interface HashCensus {
  attempts: number
  /** Attempts with no hash: they made no model request to take one from. */
  missing: number
  /** Different hashes among the attempts that had one. More than one is a normalization gap. */
  distinct: number
}

export function hashCensus(hashes: (string | undefined)[]): HashCensus {
  const present = hashes.filter((h): h is string => h !== undefined)
  return { attempts: hashes.length, missing: hashes.length - present.length, distinct: new Set(present).size }
}

/**
 * Why a run carries no prompt hash, or undefined when it does (or ran nothing). The two
 * causes need different fixes: a missing hash is an attempt that never reached the model
 * (look at its run error), while disagreeing hashes mean something task- or
 * machine-specific got past the scrubbing above.
 */
export function hashGap(c: HashCensus): string | undefined {
  if (c.attempts === 0 || (c.missing === 0 && c.distinct === 1)) return undefined
  const gap = c.distinct > 1 ? `${c.distinct} different prompts (a normalization gap in stamp.ts)` : ''
  if (c.missing === 0) return `no prompt hash: the ${c.attempts} attempts saw ${gap}`
  const none =
    c.missing === c.attempts
      ? `none of the ${c.attempts} attempts made a model request to hash`
      : `${c.missing} of ${c.attempts} attempts made no model request to hash`
  if (c.distinct > 1) return `no prompt hash: ${none}, and the rest saw ${gap}`
  return c.distinct === 1 ? `no prompt hash: ${none} (the other ${c.attempts - c.missing} agree)` : `no prompt hash: ${none}`
}
