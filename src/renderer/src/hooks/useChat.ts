import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalPolicy } from '@shared/types'
import type { AgentEvent, ToolApprovalDecision } from '@shared/agent'
import { reduceEvent, type DisplayItem } from '../lib/items'

interface SendParams {
  conversationId: string
  userText: string
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

export interface ChatController {
  items: DisplayItem[]
  running: boolean
  send: (params: SendParams) => Promise<void>
  cancel: () => void
  approve: (callId: string, decision: ToolApprovalDecision) => void
  /** Replace the transcript (e.g. when switching conversations). */
  reset: (items: DisplayItem[]) => void
}

export function useChat(): ChatController {
  const [items, setItems] = useState<DisplayItem[]>([])
  const [running, setRunning] = useState(false)
  const runIdRef = useRef<string | null>(null)

  useEffect(() => {
    return window.api.onAgentEvent((e: AgentEvent) => {
      if (e.runId !== runIdRef.current) return
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
    setItems((prev) => [...prev, { kind: 'user', id: `u-${runId}`, text: params.userText }])
    setRunning(true)
    await window.api.startAgent({
      runId,
      conversationId: params.conversationId,
      userText: params.userText,
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

  const reset = useCallback((next: DisplayItem[]) => {
    setItems(next)
    setRunning(false)
    runIdRef.current = null
  }, [])

  return { items, running, send, cancel, approve, reset }
}
