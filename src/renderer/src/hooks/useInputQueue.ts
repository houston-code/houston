import { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '@shared/images'
import type { ApprovalPolicy } from '@shared/types'
import type { QueuedInputMeta } from '@shared/queue'

export interface InputQueue {
  /** Messages queued for the open conversation, awaiting its run finishing. */
  queued: QueuedInputMeta[]
  /** Queue a message typed mid-run (sent combined when the run ends). */
  enqueue: (input: {
    text: string
    images?: ImageAttachment[]
    providerId: string
    model: string
    approvalPolicy: ApprovalPolicy
    /**
     * Queue into this conversation instead of the open one. For a fallback that
     * resolves after an async gap (a steer that the run declined), during which the
     * user may have navigated away — the text belongs to the conversation it was
     * typed in, not wherever they are now.
     */
    conversationId?: string
  }) => void
  /** Drop one queued message by id. */
  remove: (id: string) => void
  /** Discard the open conversation's queue. */
  clear: () => void
  /** Dispatch the open conversation's queued messages now (e.g. after Stop). */
  flush: () => void
}

/**
 * View of the open conversation's queued input. The queue itself lives in the
 * main process (so a follow-up still fires when its conversation's run finishes,
 * even after navigating away); this hook reads it for the open conversation and
 * reflects changes — both the optimistic results of add/remove/clear and the
 * push the main process sends when an auto-flush empties the queue.
 */
export function useInputQueue(conversationId: string | null): InputQueue {
  const [queued, setQueued] = useState<QueuedInputMeta[]>([])
  const convIdRef = useRef<string | null>(conversationId)
  convIdRef.current = conversationId

  // Load the queue for whichever conversation is open (and empty the bar when none).
  useEffect(() => {
    if (!conversationId) {
      setQueued([])
      return
    }
    let cancelled = false
    void window.api.listQueue(conversationId).then((items) => {
      if (!cancelled) setQueued(items)
    })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  // Main pushes when it auto-flushes a queue (the open conversation's bar clears).
  useEffect(() => {
    return window.api.onQueueChanged(({ conversationId: cid, items }) => {
      if (cid === convIdRef.current) setQueued(items)
    })
  }, [])

  const enqueue = useCallback<InputQueue['enqueue']>((input) => {
    // An explicit target wins over the open conversation, so a deferred fallback
    // queues into the chat the text was typed in even after navigating away.
    const cid = input.conversationId ?? convIdRef.current
    if (!cid) return
    void window.api
      .queueInput({
        conversationId: cid,
        userText: input.text,
        images: input.images,
        providerId: input.providerId,
        model: input.model,
        approvalPolicy: input.approvalPolicy
      })
      .then((items) => {
        if (convIdRef.current === cid) setQueued(items)
      })
  }, [])

  const remove = useCallback((id: string) => {
    const cid = convIdRef.current
    if (!cid) return
    void window.api.dequeueInput(cid, id).then((items) => {
      if (convIdRef.current === cid) setQueued(items)
    })
  }, [])

  const clear = useCallback(() => {
    const cid = convIdRef.current
    if (!cid) return
    void window.api.clearQueue(cid).then((items) => {
      if (convIdRef.current === cid) setQueued(items)
    })
  }, [])

  // Dispatch now. Main clears the queue and pushes IPC.agentQueueChanged (which the
  // effect above applies), then streams the follow-up run's turn_start for adoption.
  const flush = useCallback(() => {
    const cid = convIdRef.current
    if (!cid) return
    void window.api.flushQueue(cid)
  }, [])

  return { queued, enqueue, remove, clear, flush }
}
