import { useEffect, useRef, useState } from 'react'
import type { ChatStatusMap } from '@shared/chatStatus'
import { arrivedPrompts, waitingToastText, type ArrivedPrompt } from '../lib/otherChatPrompts'
import { Toast } from './Toasts'

/** How long the note stays (paused while hovered or focused, like every toast). */
export const WAITING_TOAST_MS = 12_000

/**
 * A note in the toast stack when another chat starts waiting on the user (an approval,
 * a question, a plan, an MCP server asking for input). Desktop notifications stay
 * quiet while Houston is focused, and the sidebar dot and the title bar's "need you"
 * pill are easy to miss while working in a different chat, so a blocked chat could sit
 * idle unnoticed. Finished chats get no note: their unread dot is enough.
 *
 * Shows the latest arrival only. It goes away on its own, when the user opens that
 * chat, or once that chat stops waiting.
 */
export function WaitingChatToast({
  chatStatus,
  currentId,
  titleOf,
  onOpen
}: {
  chatStatus: ChatStatusMap
  currentId: string | null
  titleOf: (id: string) => string
  onOpen: (id: string) => void
}): JSX.Element | null {
  const [note, setNote] = useState<ArrivedPrompt | null>(null)
  const prev = useRef<ChatStatusMap | null>(null)
  const seen = useRef(0)

  useEffect(() => {
    const before = prev.current
    prev.current = chatStatus
    // The empty map the window starts with, then the seeded status it opened into:
    // what was already waiting then is not news (the title bar's pill shows it).
    if (before !== chatStatus) seen.current++
    if (before === null || seen.current <= 2) return
    const arrived = arrivedPrompts(before, chatStatus, currentId)
    if (arrived.length > 0) setNote(arrived[arrived.length - 1])
  }, [chatStatus, currentId])

  // Answered elsewhere, or the user went to that chat: the note has nothing left to say.
  const stale =
    note !== null && (note.id === currentId || (chatStatus[note.id]?.pending.length ?? 0) === 0)
  useEffect(() => {
    if (stale) setNote(null)
  }, [stale])

  if (!note || stale) return null
  return (
    <Toast ms={WAITING_TOAST_MS} resetKey={note} onDone={() => setNote(null)}>
      <span className="undo-toast__text">{waitingToastText(titleOf(note.id), note.prompt)}</span>
      <button
        type="button"
        className="undo-toast__btn"
        onClick={() => {
          onOpen(note.id)
          setNote(null)
        }}
      >
        Open
      </button>
    </Toast>
  )
}
