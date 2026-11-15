import { retryProgress } from './agent'
import { throttleNotice, type ThrottleInfo } from './rateLimit'

/**
 * What every client says when a run reports a retry, a model fallback, a compaction,
 * or a verification result, so the desktop transcript, the TUI,
 * headless and editors word them alike. Plain sentences without glyphs or styling:
 * each client adds its own mark (the desktop's ⟳, the terminal's "·") and color. The
 * limit notice lives with the run-end records (`limitNoticeText` in runEnd.ts), and
 * the missing-runtime one with the runtimes (`runtimeMissingText` in runtimes.ts).
 */

/** A retry of a failed request: the throttle wait when rate limited, else the error. */
export function retryNoticeText(e: { attempt: number; max?: number; message: string; throttle?: ThrottleInfo }): string {
  return e.throttle
    ? throttleNotice(e.throttle, retryProgress(e))
    : `Connection issue, retrying (${retryProgress(e)}): ${e.message}`
}

/** The model was unavailable and another one answered. */
export function modelFallbackText(e: { from: string; to: string; reason: string }): string {
  return `${e.from} was unavailable, so this reply came from ${e.to}. ${e.reason}`.trimEnd()
}

/** Earlier messages were summarized to make room. */
export function compactionNoticeText(summarized: number): string {
  return `Compacted ${summarized} earlier message${summarized === 1 ? '' : 's'} to stay within the context window.`
}

/** The end-of-run verification command's result. */
export function verificationNoticeText(passed: boolean): string {
  return passed ? 'Verification passed.' : 'Verification failed, attempting to self-correct.'
}
