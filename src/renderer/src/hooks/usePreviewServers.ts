import { useEffect, useState } from 'react'
import type { PreviewServer } from '@shared/preview'

/**
 * The dev servers the agent has started (background `run_shell` processes), kept
 * in sync with the main process. Main owns the truth — a server can start, reveal
 * its URL, or exit at any time — so we seed from a one-shot query and then follow
 * the IPC.previewServersChanged broadcast. Drives the Preview dock.
 */
export function usePreviewServers(): PreviewServer[] {
  const [servers, setServers] = useState<PreviewServer[]>([])

  useEffect(() => {
    // Guard for test setups that stub only part of `window.api`.
    if (typeof window.api?.listPreviewServers !== 'function') return
    let alive = true
    void window.api.listPreviewServers().then((list) => {
      if (alive) setServers(list)
    })
    const off = window.api.onPreviewServersChanged((list) => setServers(list))
    return () => {
      alive = false
      off()
    }
  }, [])

  return servers
}
