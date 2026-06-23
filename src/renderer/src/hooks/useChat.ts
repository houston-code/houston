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

/** A revertable set of file changes from the most recent turn. */
export interface Checkpoint {
  runId: string
  files: number
}

export interface ChatController {
  items: DisplayItem[]
  running: boolean
  /** Running token usage for the open conversation's in-session turns, or null. */
  usage: SessionUsage | null
  /** The current/last turn's revertable file changes, or null. */
  checkpoint: Checkpoint | null
  send: (params: SendParams) => Promise<void>
  cancel: () => void
  approve: (callId: string, decision: ToolApprovalDecision) => void
  /** Revert the current checkpoint's file changes. Returns the count restored. */
  revertCheckpoint: () => Promise<number>
  /** Replace the transcript (e.g. when switching conversations). */
  reset: (items: DisplayItem[]) => void
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file'])

export function useChat(): ChatController {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [running, setRunning] = useState(false)
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null)
  const runIdRef = useRef<string | null>(null)

  useEffect(() => {
    return window.api.onAgentEvent((e: AgentEvent) => {
      if (e.runId !== runIdRef.current) return
      if (e.type === 'usage') {
        setUsage((prev) => ({
          context: e.inputTokens || prev?.context || 0,
          output: (prev?.output ?? 0) + (e.outputTokens || 0)
        }))
        return
      }
      // Track successful file writes so the turn's changes can be reverted.
      if (e.type === 'tool_result' && e.ok && WRITE_TOOLS.has(e.name)) {
        const runId = e.runId
        setCheckpoint((prev) => ({ runId, files: (prev?.runId === runId ? prev.files : 0) + 1 }))
      }
      setItems((prev) => reduceEvent(prev, e))
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

  const cancel = useCallback(() => {
    if (runIdRef.current) void window.api.cancelAgent(runIdRef.current)
  }, [])

  const approve = useCallback((callId: string, decision: ToolApprovalDecision) => {
    if (runIdRef.current) void window.api.approveTool(runIdRef.current, callId, decision)
  }, [])

  const revertCheckpoint = useCallback(async (): Promise<number> => {
    if (!checkpoint) return 0
    const restored = await window.api.restoreCheckpoint(checkpoint.runId)
    setCheckpoint(null)
    return restored
  }, [checkpoint])

  const reset = useCallback((next: DisplayItem[]) => {
    setItems(next)
    setRunning(false)
    setUsage(null)
    setCheckpoint(null)
    runIdRef.current = null
  }, [])

  return { items, running, usage, checkpoint, send, cancel, approve, revertCheckpoint, reset }
}
