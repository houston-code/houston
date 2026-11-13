import { useEffect, useState } from 'react'
import type { PreviewServer } from '@shared/preview'

/**
 * The dev servers the agent has started (background `run_shell` processes), kept
 * in sync with the main process. Main owns the truth — a server can start, reveal
 * its URL, or exit at any time — so we seed from a one-shot query and then follow
 * the IPC.previewServersChanged broadcast. Drives the Preview dock.
 */
/**
 * What {@link usePreviewServers} returns until main has answered: empty, but told apart
 * by identity from an answered empty list, so a consumer that snapshots "what was
 * already running" (useAutoOpenPreview) waits for the real list. Frozen; never mutated.
 */
export const PREVIEW_SERVERS_UNSEEDED: PreviewServer[] = Object.freeze([]) as unknown as PreviewServer[]

export function usePreviewServers(): PreviewServer[] {
  const [servers, setServers] = useState<PreviewServer[]>(PREVIEW_SERVERS_UNSEEDED)

  useEffect(() => {
    // Guard for test setups that stub only part of `window.api`.
    if (typeof window.api?.listPreviewServers !== 'function') return
    let alive = true
    // A broadcast is newer than the seed query's answer, so once one lands the seed is dropped.
    let changed = false
    void window.api.listPreviewServers().then((list) => {
      if (alive && !changed) setServers(list)
    })
    const off = window.api.onPreviewServersChanged((list) => {
      changed = true
      setServers(list)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return servers
}
