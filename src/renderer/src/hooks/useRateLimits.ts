import { useEffect, useState } from 'react'
import type { RateLimitState } from '@shared/rateLimitState'

/**
 * Every provider's last rate-limit state, read once from main and then followed.
 * Empty until a provider reports one (and where the bridge lacks it, as in tests).
 */
export function useRateLimits(): RateLimitState[] {
  const [states, setStates] = useState<RateLimitState[]>([])
  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.api : undefined
    if (!api || typeof api.getRateLimits !== 'function') return
    let live = true
    void api
      .getRateLimits()
      .then((s) => {
        if (live) setStates(s)
      })
      .catch(() => {})
    const off = typeof api.onRateLimitsChanged === 'function' ? api.onRateLimitsChanged((s) => setStates(s)) : undefined
    return () => {
      live = false
      off?.()
    }
  }, [])
  return states
}
