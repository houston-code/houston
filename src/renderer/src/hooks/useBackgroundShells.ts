import { useEffect, useState } from 'react'
import type { BackgroundShellInfo } from '@shared/agent'

/**
 * The background shells (`run_shell` with `background: true`) currently tracked by
 * the main process, kept in sync with its registry. The main process owns the
 * truth — a shell can start or exit at any time, from any conversation's run — so
 * we seed from a one-shot query and then follow the IPC.shellsChanged broadcast.
 * The background-tasks indicator uses this to surface long-running commands the
 * agent spawned (dev servers, watchers) alongside chats and terminals.
 */
export function useBackgroundShells(): BackgroundShellInfo[] {
  const [shells, setShells] = useState<BackgroundShellInfo[]>([])

  useEffect(() => {
    // Guard for test setups that stub only part of `window.api`.
    if (typeof window.api?.getBackgroundShells !== 'function') return
    let alive = true
    void window.api.getBackgroundShells().then((list) => {
      if (alive) setShells(list)
    })
    const off = window.api.onShellsChanged((list) => setShells(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  return shells
}
