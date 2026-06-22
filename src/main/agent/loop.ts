import { realpathSync } from 'node:fs'
import type {
  AgentEvent,
  AgentRunRequest,
  ChatMessage,
  StopReason,
  ToolApprovalDecision,
  ToolCall
} from '@shared/agent'
import { getProvider, getSettings } from '../store'
import { createProvider } from '../providers'
import { buildSystemPrompt } from './prompt'
import { getTool, toolSchemas } from './tools'
import { needsApproval } from './approval'

const MAX_ITERATIONS = 40

interface RunState {
  abort: AbortController
  approvals: Map<string, (d: ToolApprovalDecision) => void>
  /** Flipped to true once the user chooses "always" — auto-approve the rest. */
  override: boolean
}

const runs = new Map<string, RunState>()

export function cancelRun(runId: string): void {
  const run = runs.get(runId)
  if (!run) return
  for (const resolve of run.approvals.values()) resolve('deny')
  run.approvals.clear()
  run.abort.abort()
}

export function resolveApproval(runId: string, callId: string, decision: ToolApprovalDecision): void {
  const run = runs.get(runId)
  const resolve = run?.approvals.get(callId)
  if (run && resolve) {
    run.approvals.delete(callId)
    resolve(decision)
  }
}

function waitForApproval(run: RunState, callId: string): Promise<ToolApprovalDecision> {
  return new Promise((resolve) => run.approvals.set(callId, resolve))
}

/**
 * Run the agent loop, streaming events via `send`. Never throws — errors become events.
 * `onMessages` is called whenever the message log grows, so the caller can persist it.
 */
export async function startRun(
  req: AgentRunRequest,
  send: (e: AgentEvent) => void,
  onMessages?: (messages: ChatMessage[]) => void
): Promise<void> {
  const { runId } = req
  const abort = new AbortController()
  const run: RunState = { abort, approvals: new Map(), override: false }
  runs.set(runId, run)

  type DistributiveOmitRunId<T> = T extends unknown ? Omit<T, 'runId'> : never
  const emit = (e: DistributiveOmitRunId<AgentEvent>): void =>
    send({ ...(e as object), runId } as AgentEvent)

  try {
    let workspace: string
    try {
      workspace = realpathSync(req.workspace)
    } catch {
      emit({ type: 'error', message: 'The selected project folder does not exist.' })
      return
    }

    const providerConfig = getProvider(req.providerId)
    if (!providerConfig) {
      emit({ type: 'error', message: `Unknown provider: ${req.providerId}` })
      return
    }

    let provider
    try {
      provider = createProvider(providerConfig)
    } catch (e) {
      emit({ type: 'error', message: (e as Error).message })
      return
    }

    const system = buildSystemPrompt(workspace, getSettings().systemPromptExtra)
    const tools = toolSchemas()
    const messages: ChatMessage[] = [...req.messages]

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (abort.signal.aborted) {
        emit({ type: 'done', stopReason: 'aborted' })
        return
      }

      let assistantText = ''
      const toolCalls: ToolCall[] = []
      let stopReason: StopReason = 'end_turn'

      try {
        for await (const ev of provider.streamChat({
          model: req.model,
          system,
          messages,
          tools,
          signal: abort.signal
        })) {
          if (ev.type === 'text') {
            assistantText += ev.text
            emit({ type: 'text', delta: ev.text })
          } else if (ev.type === 'tool_call') {
            toolCalls.push(ev.call)
          } else if (ev.type === 'done') {
            stopReason = ev.stopReason
          } else if (ev.type === 'error') {
            emit({ type: 'error', message: ev.message })
            return
          }
        }
      } catch (e) {
        if (abort.signal.aborted) {
          emit({ type: 'done', stopReason: 'aborted' })
        } else {
          emit({ type: 'error', message: (e as Error).message })
        }
        return
      }

      messages.push({
        role: 'assistant',
        content: assistantText,
        ...(toolCalls.length ? { toolCalls } : {})
      })
      onMessages?.(messages)

      if (toolCalls.length === 0) {
        emit({ type: 'done', stopReason })
        return
      }

      for (const call of toolCalls) {
        if (abort.signal.aborted) {
          emit({ type: 'done', stopReason: 'aborted' })
          return
        }

        const tool = getTool(call.name)
        let output: string
        let ok = true

        if (!tool) {
          output = `Unknown tool: ${call.name}`
          ok = false
        } else {
          let approved = true
          if (needsApproval(req.approvalPolicy, tool.kind, run.override)) {
            emit({
              type: 'tool_approval',
              callId: call.id,
              name: call.name,
              summary: tool.summarize(call.arguments),
              kind: tool.kind
            })
            const decision = await waitForApproval(run, call.id)
            if (decision === 'always') run.override = true
            approved = decision !== 'deny'
          }

          if (!approved) {
            output = 'Denied by the user.'
            ok = false
          } else {
            emit({ type: 'tool_start', callId: call.id, name: call.name, args: call.arguments })
            try {
              output = await tool.execute(call.arguments, {
                workspace,
                allowNetwork: req.approvalPolicy === 'full-auto' || run.override,
                signal: abort.signal
              })
            } catch (e) {
              output = `Error: ${(e as Error).message}`
              ok = false
            }
          }
        }

        emit({ type: 'tool_result', callId: call.id, name: call.name, ok, output })
        messages.push({ role: 'tool', content: output, toolCallId: call.id, toolName: call.name })
        onMessages?.(messages)
      }
    }

    emit({ type: 'done', stopReason: 'end_turn' })
  } finally {
    runs.delete(runId)
  }
}
