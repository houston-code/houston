import { useCallback, useEffect, useRef, useState } from 'react'
import type { PrStatus } from '@shared/gitActions'

/** How often the chip re-reads the pull request while the window stays open. */
export const PR_REFRESH_MS = 3 * 60_000

/**
 * The open chat's branch's pull request, for the composer chip. Read through `gh` in
 * the main process, and only for a folder whose remote is on GitHub (`enabled`), so a
 * repository elsewhere never starts gh at all. Refreshed when the folder changes, when
 * a run ends (the agent may have just opened or updated a PR), when the window regains
 * focus, and every few minutes; never in a tight loop. Null hides the chip: no PR, or
 * gh missing or signed out.
 */
export function usePrStatus(workspace: string | null, enabled: boolean, running: boolean): PrStatus | null {
  const [pr, setPr] = useState<PrStatus | null>(null)
  const wsRef = useRef(workspace)
  wsRef.current = workspace
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    const ws = wsRef.current
    if (!ws || !enabled) {
      setPr(null)
      return
    }
    if (inFlight.current) return
    inFlight.current = true
    try {
      const r = await window.api.gitPrStatus(ws)
      if (wsRef.current !== ws) return
      setPr(r.kind === 'pr' ? r.pr : null)
    } catch {
      // Keep the last value: a failed refresh shouldn't flicker the chip away.
    } finally {
      inFlight.current = false
    }
  }, [enabled])

  useEffect(() => {
    setPr(null)
    void refresh()
  }, [workspace, refresh])

  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) void refresh()
    wasRunning.current = running
  }, [running, refresh])

  useEffect(() => {
    if (!enabled) return
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    const timer = setInterval(() => void refresh(), PR_REFRESH_MS)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(timer)
    }
  }, [enabled, refresh])

  return pr
}
