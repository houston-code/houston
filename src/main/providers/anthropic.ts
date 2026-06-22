import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent, StopReason } from '@shared/agent'

const DEFAULT_MAX_TOKENS = 8192

function toAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  let mergingToolResults = false

  for (const m of messages) {
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result' as const,
        tool_use_id: m.toolCallId ?? '',
        content: m.content
      }
      const last = out[out.length - 1]
      if (mergingToolResults && last && Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(block)
      } else {
        out.push({ role: 'user', content: [block] })
        mergingToolResults = true
      }
      continue
    }

    mergingToolResults = false

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      const content: unknown[] = []
      if (m.content) content.push({ type: 'text', text: m.content })
      for (const tc of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments })
      }
      out.push({ role: 'assistant', content: content as Anthropic.MessageParam['content'] })
    }
    // 'system' is passed out-of-band via the top-level system field.
  }
  return out
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

export function createAnthropicProvider(apiKey: string, baseURL?: string): Provider {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const tools = req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema
      }))

      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          ...(req.system ? { system: req.system } : {}),
          messages: toAnthropicMessages(req.messages),
          ...(tools && tools.length ? { tools } : {})
        },
        { signal: req.signal }
      )

      // Buffer streamed tool-call JSON per content block index.
      const toolBuffers = new Map<number, { id: string; name: string; json: string }>()

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          const block = event.content_block
          if (block.type === 'tool_use') {
            toolBuffers.set(event.index, { id: block.id, name: block.name, json: '' })
          }
        } else if (event.type === 'content_block_delta') {
          const delta = event.delta
          if (delta.type === 'text_delta') {
            yield { type: 'text', text: delta.text }
          } else if (delta.type === 'input_json_delta') {
            const buf = toolBuffers.get(event.index)
            if (buf) buf.json += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          const buf = toolBuffers.get(event.index)
          if (buf) {
            let args: Record<string, unknown> = {}
            try {
              args = buf.json ? JSON.parse(buf.json) : {}
            } catch {
              args = {}
            }
            yield { type: 'tool_call', call: { id: buf.id || randomUUID(), name: buf.name, arguments: args } }
            toolBuffers.delete(event.index)
          }
        }
      }

      const final = await stream.finalMessage()
      yield {
        type: 'done',
        stopReason: mapStopReason(final.stop_reason),
        usage: {
          inputTokens: final.usage?.input_tokens,
          outputTokens: final.usage?.output_tokens
        }
      }
    }
  }
}

/** Fetch the live model list from the Anthropic API. */
export async function listAnthropicModels(apiKey: string, baseURL?: string): Promise<string[]> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
  const page = await client.models.list({ limit: 100 })
  return page.data.map((m) => m.id)
}
