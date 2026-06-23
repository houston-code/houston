import OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent, StopReason } from '@shared/agent'

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: m.content || null
      }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
        }))
      }
      out.push(msg)
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content })
    }
  }
  return out
}

function mapFinishReason(reason: string | null | undefined, hadToolCalls: boolean): StopReason {
  if (hadToolCalls || reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

/**
 * Adapter for OpenAI and any OpenAI-compatible endpoint (Ollama, LM Studio,
 * vLLM, OpenRouter, etc.). Local endpoints often don't need a key — callers pass
 * a placeholder, which compatible servers ignore.
 */
export function createOpenAIProvider(apiKey: string | null, baseURL?: string): Provider {
  const client = new OpenAI({ apiKey: apiKey || 'no-key', ...(baseURL ? { baseURL } : {}) })

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const tools = req.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))

      const stream = await client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAIMessages(req.system, req.messages),
          stream: true,
          // Ask for a final usage-only chunk. Most OpenAI-compatible servers honour
          // this; those that don't simply never send it, which we handle gracefully.
          stream_options: { include_usage: true },
          ...(tools && tools.length ? { tools } : {})
        },
        { signal: req.signal }
      )

      // Accumulate streamed tool calls by their `index`.
      const toolAcc = new Map<number, { id: string; name: string; args: string }>()
      let finishReason: string | null = null
      let inputTokens: number | undefined
      let outputTokens: number | undefined

      for await (const chunk of stream) {
        // The usage-only chunk arrives last and has an empty `choices` array.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }
        const choice = chunk.choices[0]
        if (!choice) continue
        const delta = choice.delta
        if (delta?.content) yield { type: 'text', text: delta.content }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            let acc = toolAcc.get(idx)
            if (!acc) {
              acc = { id: tc.id ?? '', name: '', args: '' }
              toolAcc.set(idx, acc)
            }
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name = tc.function.name
            if (tc.function?.arguments) acc.args += tc.function.arguments
          }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }

      const hadToolCalls = toolAcc.size > 0
      for (const acc of toolAcc.values()) {
        let args: Record<string, unknown> = {}
        try {
          args = acc.args ? JSON.parse(acc.args) : {}
        } catch {
          args = {}
        }
        yield { type: 'tool_call', call: { id: acc.id || randomUUID(), name: acc.name, arguments: args } }
      }

      yield {
        type: 'done',
        stopReason: mapFinishReason(finishReason, hadToolCalls),
        usage: { inputTokens, outputTokens }
      }
    }
  }
}

/** Fetch the live model list (GET /models). Works for OpenAI and most compatible servers. */
export async function listOpenAIModels(apiKey: string | null, baseURL?: string): Promise<string[]> {
  const client = new OpenAI({ apiKey: apiKey || 'no-key', ...(baseURL ? { baseURL } : {}) })
  const page = await client.models.list()
  return page.data.map((m) => m.id)
}
