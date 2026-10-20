import { useEffect, useState } from 'react'

/**
 * `flag`, but turning true only after it has stayed true for `ms`; it turns false at
 * once. Used to hold the pre-send tips back a moment after step 3 becomes current,
 * so they read as a follow-up rather than appearing in the same instant.
 */
export function useDelayedFlag(flag: boolean, ms: number): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!flag) {
      setReady(false)
      return
    }
    const t = setTimeout(() => setReady(true), ms)
    return () => clearTimeout(t)
  }, [flag, ms])
  return flag && ready
}
