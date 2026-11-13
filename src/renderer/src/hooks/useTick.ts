import { useEffect, useState } from 'react'

/**
 * The current time, refreshed every second while `active`, for live elapsed times.
 * Returns 0 while inactive so a caller can't mistake a stale clock for a live one.
 */
export function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [active])
  return active ? now : 0
}
