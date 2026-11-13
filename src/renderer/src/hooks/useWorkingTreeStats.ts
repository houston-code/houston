import { useCallback, useEffect, useRef, useState } from 'react'
import type { RepoShipState } from '@shared/shipAction'

/** Compact working-tree change counts for the Changes button badge. */
export interface WorkingTreeStats {
  /** Number of changed files (tracked + untracked). Drives the "has changes" highlight. */
  fileCount: number
  /** Total added / removed lines across every file. */
  added: number
  removed: number
  /** Commit/remote facts that choose the composer bar's ship action. */
  ship?: RepoShipState
  /**
   * The checked-out branch, for the status bar: a name, null when the folder is a repo
   * with no branch checked out (detached HEAD, or no commits yet), absent outside a repo.
   */
  branch?: string | null
}

const EMPTY: WorkingTreeStats = { fileCount: 0, added: 0, removed: 0 }

/** Same counts, branch and ship facts: a refresh that found nothing new keeps the old object. */
export function sameStats(a: WorkingTreeStats, b: WorkingTreeStats): boolean {
  if (a.fileCount !== b.fileCount || a.added !== b.added || a.removed !== b.removed) return false
  if (a.branch !== b.branch) return false
  const x = a.ship
  const y = b.ship
  if (!x || !y) return x === y
  if (x.hasCommits !== y.hasCommits) return false
  if (!x.remote || !y.remote) return x.remote === y.remote
  return x.remote.name === y.remote.name && x.remote.host === y.remote.host
}

/**
 * Lightweight working-tree change stats for the titlebar Changes badge. Asks main
 * for the counts only (not the full diff the Changes panel loads), and refreshes
 * when it actually matters:
 *  - the workspace changes,
 *  - a run finishes (the agent's edits have just landed), and
 *  - the window regains focus (to catch edits/commits made outside the app).
 *
 * It does not poll — those three signals cover how the working tree changes in
 * practice, and a stale count for a few seconds is harmless. A refresh that finds
 * the same numbers keeps the previous object, so it does not re-render the app.
 */
export function useWorkingTreeStats(workspace: string | null, running: boolean): WorkingTreeStats {
  const [stats, setStats] = useState<WorkingTreeStats>(EMPTY)
  const wsRef = useRef(workspace)
  wsRef.current = workspace

  // The last value set, compared before calling setStats: an updater that returns the
  // previous state still re-renders the component once, which this skips entirely.
  const statsRef = useRef(stats)
  const update = useCallback((next: WorkingTreeStats) => {
    if (sameStats(statsRef.current, next)) return
    statsRef.current = next
    setStats(next)
  }, [])

  const refresh = useCallback(async () => {
    const ws = wsRef.current
    if (!ws) {
      update(EMPTY)
      return
    }
    try {
      const c = await window.api.getWorkingTreeStats(ws)
      // Guard against a workspace switch that lands while this fetch is in flight.
      if (wsRef.current !== ws) return
      update(
        c.isRepo
          ? { fileCount: c.fileCount, added: c.added, removed: c.removed, ship: c.ship, branch: c.branch }
          : EMPTY
      )
    } catch {
      // Non-fatal — the badge just keeps its last value.
    }
  }, [update])

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
