import { useCallback, useEffect, useRef, useState } from 'react'

/** Compact working-tree change counts for the Changes button badge. */
export interface WorkingTreeStats {
  /** Number of changed files (tracked + untracked). Drives the "has changes" highlight. */
  fileCount: number
  /** Total added / removed lines across every file. */
  added: number
  removed: number
}

const EMPTY: WorkingTreeStats = { fileCount: 0, added: 0, removed: 0 }

/**
 * Lightweight working-tree change stats for the titlebar Changes badge. Reuses the
 * same IPC the Changes panel uses, and refreshes when it actually matters:
 *  - the workspace changes,
 *  - a run finishes (the agent's edits have just landed), and
 *  - the window regains focus (to catch edits/commits made outside the app).
 *
 * It does not poll — those three signals cover how the working tree changes in
 * practice, and a stale count for a few seconds is harmless.
 */
export function useWorkingTreeStats(workspace: string | null, running: boolean): WorkingTreeStats {
  const [stats, setStats] = useState<WorkingTreeStats>(EMPTY)
  const wsRef = useRef(workspace)
  wsRef.current = workspace

  const refresh = useCallback(async () => {
    const ws = wsRef.current
    if (!ws) {
      setStats(EMPTY)
      return
    }
    try {
      const c = await window.api.getWorkingTreeChanges(ws)
      // Guard against a workspace switch that lands while this fetch is in flight.
      if (wsRef.current !== ws) return
      setStats(
        c.isRepo ? { fileCount: c.files.length, added: c.added, removed: c.removed } : EMPTY
      )
    } catch {
      // Non-fatal — the badge just keeps its last value.
    }
  }, [])

  // Refresh on workspace change (and initial mount).
  useEffect(() => {
    void refresh()
  }, [workspace, refresh])

  // Refresh when a run finishes (running: true → false) — edits land during the run.
  const wasRunning = useRef(running)
  useEffect(() => {
    if (wasRunning.current && !running) void refresh()
    wasRunning.current = running
  }, [running, refresh])

  // Catch edits or commits made outside the app while it was in the background.
  useEffect(() => {
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return stats
}
