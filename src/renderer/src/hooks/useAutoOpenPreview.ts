import { useEffect, useRef } from 'react'
import type { PreviewServer } from '@shared/preview'
import { PREVIEW_SERVERS_UNSEEDED } from './usePreviewServers'

/**
 * Which chat, if any, should have its Preview opened now: the open chat, when one of
 * its dev servers has just shown a URL and its Preview hasn't been opened this way
 * before. Updates `seen` (servers with a URL already observed) and `opened` (chats
 * already auto-opened) in place. Pure apart from those sets, for testing.
 */
export function chatToAutoOpen(
  servers: readonly PreviewServer[],
  currentId: string | null,
  seen: Set<string>,
  opened: Set<string>
): string | null {
  const fresh = servers.filter((s) => s.running && s.url && !seen.has(s.id))
  for (const s of fresh) seen.add(s.id)
  if (!currentId || opened.has(currentId)) return null
  if (!fresh.some((s) => s.conversationId === currentId)) return null
  opened.add(currentId)
  return currentId
}

/**
 * Open the Preview dock once per chat when the agent starts a dev server whose URL is
 * detected in that chat (Settings > Tools > Preview turns this off). Servers already
 * running when the window loads don't count, and a chat the user closed the Preview
 * in after an auto-open isn't reopened by a later server.
 */
export function useAutoOpenPreview(
  servers: readonly PreviewServer[],
  currentId: string | null,
  enabled: boolean,
  open: () => void
): void {
  const seen = useRef<Set<string> | null>(null)
  const opened = useRef(new Set<string>())
  useEffect(() => {
    // Main hasn't answered yet: an empty list here says nothing about what is running.
    if (servers === PREVIEW_SERVERS_UNSEEDED) return
    if (seen.current === null) {
      seen.current = new Set(servers.filter((s) => s.running && s.url).map((s) => s.id))
      return
    }
    const target = chatToAutoOpen(servers, currentId, seen.current, opened.current)
    if (target && enabled) open()
  }, [servers, currentId, enabled, open])
}
