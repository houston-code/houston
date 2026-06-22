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
