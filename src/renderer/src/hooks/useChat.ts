import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalPolicy } from '@shared/types'
import type { AgentEvent, ToolApprovalDecision } from '@shared/agent'
import type { ImageAttachment } from '@shared/images'
import type { SessionUsage } from '@shared/usage'
import { reduceEvent, type DisplayItem } from '../lib/items'

interface SendParams {
  conversationId: string
  userText: string
  images?: ImageAttachment[]
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

type RetryParams = Omit<SendParams, 'userText' | 'images'>

/** A revertable set of file changes from the most recent turn. */
export interface Checkpoint {
  runId: string
  files: number
  /** True once reverted — the changes can now be re-applied (redone). */
  reverted: boolean
}

export interface ChatController {
  items: DisplayItem[]
  running: boolean
  /** The open conversation's persisted running token usage, or null. */
  usage: SessionUsage | null
  /** The current/last turn's revertable file changes, or null. */
  checkpoint: Checkpoint | null
  /** True when the last finished run ended in an error (offer a retry). */
  errored: boolean
  send: (params: SendParams) => Promise<void>
  /** Re-run the last turn after a failure, without re-sending the user message. */
  retry: (params: RetryParams) => Promise<void>
  cancel: () => void
  approve: (callId: string, decision: ToolApprovalDecision) => void
  /** Answer a pending `ask_user` question from the in-flight run. */
  answerQuestion: (callId: string, answer: string) => void
  /** Change the approval policy of the in-flight run, if any (live mode switch). */
  setPolicy: (policy: ApprovalPolicy) => void
  /** Revert the current checkpoint's file changes. Returns the count restored. */
  revertCheckpoint: () => Promise<number>
  /** Re-apply a reverted checkpoint's file changes. Returns the count re-applied. */
  reapplyCheckpoint: () => Promise<number>
  /**
   * Replace the transcript and (optionally) seed usage and the errored flag, e.g.
   * when switching conversations — `errored` restores the persisted Retry banner.
   */
  reset: (items: DisplayItem[], usage?: SessionUsage | null, errored?: boolean) => void
  /**
   * Re-attach to a run already in flight in the main process — e.g. after
   * switching back to a conversation whose run kept going in the background.
   * Restores the running UI (Stop button) and routes subsequent events,
   * approvals, and cancel back to that run. Call after {@link reset}.
   *
   * `pendingPrompts` are the approval/question events still blocking that run;
   * they're folded into the transcript so a prompt that was awaiting the user
   * re-renders its UI (the live events are one-shot and already fired).
   */
  adopt: (runId: string, pendingPrompts?: AgentEvent[]) => void
  /** Append a transient notice to the transcript (e.g. slash-command feedback). */
  notify: (text: string, tone?: 'info' | 'error') => void
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

export function useChat(conversationId: string | null = null): ChatController {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null)
  const [errored, setErrored] = useState(false)
  const runIdRef = useRef<string | null>(null)
  // The open conversation, so we can adopt a main-initiated follow-up run (queued
  // input) that targets it and ignore background runs on other conversations.
  const convIdRef = useRef<string | null>(conversationId)
  convIdRef.current = conversationId

  useEffect(() => {
    return window.api.onAgentEvent((e: AgentEvent) => {
      if (e.type === 'turn_start') {
        // The main process auto-started a follow-up turn from the queue. Adopt it
        // only when it's for the conversation we're viewing; otherwise it's a
        // background run whose result we'll see from disk on next open.
        if (e.conversationId !== convIdRef.current) return
        runIdRef.current = e.runId
        setRunning(true)
        setErrored(false)
        setCheckpoint(null)
        setItems((prev) => [
          ...prev,
          {
            kind: 'user',
            id: `u-${e.runId}`,
            text: e.userText,
            ...(e.images?.length ? { images: e.images } : {})
          }
        ])
        return
      }
      if (e.runId !== runIdRef.current) return
      if (e.type === 'usage') {
        // The main process accumulates and persists; the event carries the
        // conversation's cumulative totals, so we set rather than sum.
        setUsage((prev) => ({
          context: e.inputTokens || prev?.context || 0,
          output: e.outputTokens || prev?.output || 0,
          cost: e.cost || prev?.cost || 0
        }))
        return
      }
      // Track successful file writes so the turn's changes can be reverted.
      if (e.type === 'tool_result' && e.ok && WRITE_TOOLS.has(e.name)) {
        const runId = e.runId
        setCheckpoint((prev) => ({
          runId,
          files: (prev?.runId === runId ? prev.files : 0) + 1,
          reverted: false
        }))
      }
      setItems((prev) => reduceEvent(prev, e))
      if (e.type === 'error') setErrored(true)
      if (e.type === 'done' || e.type === 'error') {
        setRunning(false)
        runIdRef.current = null
      }
    })
  }, [])

  const send = useCallback(async (params: SendParams) => {
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setItems((prev) => [
      ...prev,
      {
        kind: 'user',
        id: `u-${runId}`,
        text: params.userText,
        ...(params.images?.length ? { images: params.images } : {})
      }
    ])
    setRunning(true)
    setCheckpoint(null)
    setErrored(false)
    await window.api.startAgent({
      runId,
      conversationId: params.conversationId,
      userText: params.userText,
      images: params.images,
      providerId: params.providerId,
      model: params.model,
      approvalPolicy: params.approvalPolicy
    })
  }, [])

  const retry = useCallback(async (params: RetryParams) => {
    const runId = crypto.randomUUID()
    runIdRef.current = runId
    setRunning(true)
    setErrored(false)
    await window.api.retryAgent({ runId, ...params })
  }, [])

  const cancel = useCallback(() => {
    if (runIdRef.current) void window.api.cancelAgent(runIdRef.current)
  }, [])

  const approve = useCallback((callId: string, decision: ToolApprovalDecision) => {
    if (runIdRef.current) void window.api.approveTool(runIdRef.current, callId, decision)
  }, [])

  const answerQuestion = useCallback((callId: string, answer: string) => {
    if (runIdRef.current) void window.api.answerQuestion(runIdRef.current, callId, answer)
  }, [])

  const setPolicy = useCallback((policy: ApprovalPolicy) => {
    if (runIdRef.current) void window.api.setAgentPolicy(runIdRef.current, policy)
  }, [])

  const revertCheckpoint = useCallback(async (): Promise<number> => {
    if (!checkpoint) return 0
    const restored = await window.api.restoreCheckpoint(checkpoint.runId)
    // Keep the checkpoint (now reverted) so the change can be redone.
    setCheckpoint({ ...checkpoint, reverted: true })
    return restored
  }, [checkpoint])

  const reapplyCheckpoint = useCallback(async (): Promise<number> => {
    if (!checkpoint) return 0
    const reapplied = await window.api.reapplyCheckpoint(checkpoint.runId)
    setCheckpoint({ ...checkpoint, reverted: false })
    return reapplied
  }, [checkpoint])

  const reset = useCallback(
    (next: DisplayItem[], nextUsage: SessionUsage | null = null, nextErrored = false) => {
      setItems(next)
      setRunning(false)
      setUsage(nextUsage)
      setCheckpoint(null)
      // Seed from the conversation's persisted failure so a reload restores the
      // "last turn failed" banner; a live run we adopt afterwards clears it.
      setErrored(nextErrored)
      runIdRef.current = null
    },
    []
  )

  const adopt = useCallback((runId: string, pendingPrompts: AgentEvent[] = []) => {
    runIdRef.current = runId
    setRunning(true)
    setErrored(false)
    // Re-render any approval/question still awaiting the user. reduceEvent upserts
    // by callId, so replaying onto a transcript rebuilt from the log updates the
    // matching row rather than duplicating it.
    if (pendingPrompts.length > 0) {
      setItems((prev) => pendingPrompts.reduce((acc, ev) => reduceEvent(acc, ev), prev))
    }
  }, [])

  const notify = useCallback((text: string, tone: 'info' | 'error' = 'info') => {
    setItems((prev) => [...prev, { kind: 'notice', id: crypto.randomUUID(), text, tone }])
  }, [])

  return {
    items,
    running,
    usage,
    checkpoint,
    errored,
    send,
    retry,
    cancel,
    approve,
    answerQuestion,
    setPolicy,
    revertCheckpoint,
    reapplyCheckpoint,
    reset,
    adopt,
    notify
  }
}
