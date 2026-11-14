import { useEffect, useState } from 'react'

/**
 * The current time, refreshed every `intervalMs` (a second by default) while `active`,
 * for live elapsed times. Returns 0 while inactive so a caller can't mistake a stale
 * clock for a live one.
 */
export function useTick(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [active, intervalMs])
  return active ? now : 0
}
