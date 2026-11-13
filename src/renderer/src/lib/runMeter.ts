import type { AgentEvent } from '@shared/agent'
import { formatElapsed } from '@shared/elapsed'
import { formatTokens } from '@shared/usage'

/**
 * The running turn's clock and output-token count, for the status bar.
 *
 * Providers report a round's tokens only once the round ends (the `usage` event), so
 * a long reply would sit at 0 until it finished. While a round streams, its output
 * is estimated from the characters streamed so far (about four per token, the usual
 * rule of thumb for English and code); when the round's `usage` lands, the estimate
 * is replaced by the provider's own count.
 */
export interface RunMeter {
  /** When the turn started, epoch ms. */
  startedAt: number
  /** Output tokens the provider has reported for this turn's finished rounds. */
  reported: number
  /** Characters of text and reasoning streamed in the round now in progress. */
  streamedChars: number
}

/** Characters per token for the in-flight estimate. */
const CHARS_PER_TOKEN = 4

export function startMeter(startedAt: number): RunMeter {
  return { startedAt, reported: 0, streamedChars: 0 }
}

/**
 * Fold one run event into the meter. `outputDelta` is the growth of the chat's
 * cumulative output count that a `usage` event carries (the desktop sends running
 * totals, not per-round numbers), worked out by the caller that holds the previous
 * total. Returns the same object when nothing changed.
 */
export function meterOnEvent(m: RunMeter, e: AgentEvent, outputDelta = 0): RunMeter {
  switch (e.type) {
    case 'text':
    case 'reasoning':
      return e.delta ? { ...m, streamedChars: m.streamedChars + e.delta.length } : m
    case 'turn_discarded':
      // The retracted text is not part of the reply the user keeps.
      return { ...m, streamedChars: Math.max(0, m.streamedChars - e.textChars - e.reasoningChars) }
    case 'usage':
      return { ...m, reported: m.reported + Math.max(0, outputDelta), streamedChars: 0 }
    default:
      return m
  }
}

/** Output tokens so far: what the provider reported plus the estimate for the open round. */
export function meterTokens(m: RunMeter): number {
  return m.reported + Math.round(m.streamedChars / CHARS_PER_TOKEN)
}

/** "12s · 1.2k tokens": the status bar's live meter. */
export function meterText(m: RunMeter, now: number): string {
  const tokens = meterTokens(m)
  const elapsed = formatElapsed(now - m.startedAt)
  return tokens > 0 ? `${elapsed} · ${formatTokens(tokens)} ${tokens === 1 ? 'token' : 'tokens'}` : elapsed
}
