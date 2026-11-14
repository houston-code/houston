import type { RateLimitState } from '@shared/rateLimitState'
import { rateLimitLine, remainingText, resetText } from '@shared/rateLimitState'
import { useTick } from '../hooks/useTick'

/**
 * The status bar's note of the selected provider's last rate-limit state: what was
 * left in its window and when it resets, from the last time it throttled a request.
 * Nothing shows until a provider has reported one.
 */
export function RateLimitChip({ state }: { state: RateLimitState | undefined }): JSX.Element | null {
  // Re-render while a reset is ahead, so "resets 3:42 PM" drops once it has passed.
  const now = useTick(state?.resetAt !== undefined) || Date.now()
  if (!state) return null
  const short = [remainingText(state), resetText(state, now)].filter(Boolean).join(', ') || 'Rate limited'
  return (
    <span className="statusbar__quota" title={`Provider rate limit: ${rateLimitLine(state, now)}`}>
      {short}
    </span>
  )
}
