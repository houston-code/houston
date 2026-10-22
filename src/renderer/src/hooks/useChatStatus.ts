import { useEffect, useState } from 'react'
import type { ChatStatusMap } from '@shared/chatStatus'

const EMPTY: ChatStatusMap = {}

/**
 * The live status of every conversation with a run (running, and which prompts block
 * it), kept in sync with the main process. Main owns the truth (a run can start,
 * block, or finish from any window or a queued follow-up), so we seed from a one-shot
 * query and then follow the IPC.chatStatusChanged broadcast. The sidebar uses this to
 * mark every chat, not just the open one, so backgrounded work is visible.
 */
export function useChatStatus(): ChatStatusMap {
  const [status, setStatus] = useState<ChatStatusMap>(EMPTY)

  useEffect(() => {
    // Guard for test setups that stub only part of `window.api`.
    if (typeof window.api?.getChatStatus !== 'function') return
    let alive = true
    // A broadcast that lands before the seed query resolves is newer than it: once
    // one has arrived, the seed is stale and must not overwrite it.
    let heard = false
    void window.api.getChatStatus().then((s) => {
      if (alive && !heard) setStatus(s)
    })
    const off = window.api.onChatStatusChanged((s) => {
      heard = true
      setStatus(s)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return status
}
