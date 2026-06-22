/**
 * Provider-agnostic chat + tool-calling types. Each provider adapter translates
 * to/from these so the agent loop and UI never depend on a specific SDK shape.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

/** A JSON Schema object describing a tool's parameters. */
export type JSONSchema = Record<string, unknown>

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChatMessage {
  role: ChatRole
  content: string
  /** Present on assistant turns that call tools. */
  toolCalls?: ToolCall[]
  /** Present on `tool` turns — the id of the call this result answers. */
  toolCallId?: string
  /** Present on `tool` turns — the name of the tool that produced this result. */
  toolName?: string
}

export interface ToolSchema {
  name: string
  description: string
  parameters: JSONSchema
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error' | 'aborted'

export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
}

/** A single event in a streamed provider response. */
export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; stopReason: StopReason; usage?: TokenUsage }
  | { type: 'error'; message: string }

export interface ChatRequest {
  model: string
  system?: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  signal?: AbortSignal
}

export interface Provider {
  streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent>
}

// ---- Agent run protocol (main <-> renderer) ----

import type { ApprovalPolicy } from './types'

export interface ConversationMeta {
  id: string
  title: string
  workspace: string
  providerId: string
  model: string
  createdAt: number
  updatedAt: number
}

export interface Conversation extends ConversationMeta {
  messages: ChatMessage[]
}

/** Internal input to the agent loop. */
export interface AgentRunRequest {
  runId: string
  workspace: string
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
  messages: ChatMessage[]
}

/** What the renderer sends to start a turn in a conversation. */
export interface AgentSendRequest {
  runId: string
  conversationId: string
  userText: string
  providerId: string
  model: string
  approvalPolicy: ApprovalPolicy
}

export type ToolApprovalDecision = 'allow' | 'deny' | 'always'

/** Events streamed from a running agent to the renderer. */
export type AgentEvent =
  | { runId: string; type: 'text'; delta: string }
  | { runId: string; type: 'tool_start'; callId: string; name: string; args: Record<string, unknown> }
  | {
      runId: string
      type: 'tool_approval'
      callId: string
      name: string
      summary: string
      kind: 'read' | 'write' | 'shell' | 'network'
    }
  | { runId: string; type: 'tool_result'; callId: string; name: string; ok: boolean; output: string }
  | { runId: string; type: 'done'; stopReason: StopReason }
  | { runId: string; type: 'error'; message: string }

