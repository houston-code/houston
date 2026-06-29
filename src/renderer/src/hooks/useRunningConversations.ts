import { useEffect, useState } from 'react'

/**
 * The set of conversation ids that currently have a live agent run, kept in sync
 * with the main process. The main process owns the truth (a run can start, finish,
 * or be cancelled from any window or a queued follow-up), so we seed from a one-shot
 * query and then follow the IPC.agentRunsChanged broadcast. The sidebar uses this to
 * mark every running chat — not just the open one — so a backgrounded run is visible.
 */
export function useRunningConversations(): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())

  useEffect(() => {
    // Guard for test setups that stub only part of `window.api`.
    if (typeof window.api?.getRunningConversations !== 'function') return
    let alive = true
    void window.api.getRunningConversations().then((list) => {
      if (alive) setIds(new Set(list))
    })
    const off = window.api.onRunsChanged((list) => setIds(new Set(list)))
    return () => {
      alive = false
      off()
    }
  }, [])

  return ids
}
