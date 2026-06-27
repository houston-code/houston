import type Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatRequest,
  Provider,
  ProviderStreamEvent,
  ReasoningBlock,
  StopReason
} from '@shared/agent'
import { anthropicThinking } from './reasoning'

const DEFAULT_MAX_TOKENS = 8192

/**
 * Build the `thinking`/`redacted_thinking` content blocks that must lead an
 * assistant turn when extended thinking is enabled. Returns [] when thinking is
 * off or the turn has no (signed) reasoning to replay.
 */
function thinkingBlocks(m: ChatMessage, thinkingEnabled: boolean): unknown[] {
  if (!thinkingEnabled || !m.reasoning?.length) return []
  const blocks: unknown[] = []
  for (const r of m.reasoning) {
    if (r.redactedData) {
      blocks.push({ type: 'redacted_thinking', data: r.redactedData })
    } else if (r.signature) {
      blocks.push({ type: 'thinking', thinking: r.text, signature: r.signature })
    }
  }
  return blocks
}

function toAnthropicMessages(
  messages: ChatMessage[],
  thinkingEnabled: boolean
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = []
  let mergingToolResults = false

  for (const m of messages) {
    if (m.role === 'tool') {
      // When the tool read an image/PDF, return it as image/document blocks the
      // model can actually view; otherwise plain text.
      let content: unknown = m.content
      if (m.images?.length || m.documents?.length) {
        const blocks: unknown[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const img of m.images ?? []) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data }
          })
        }
        for (const doc of m.documents ?? []) {
          blocks.push({
            type: 'document',
            source: { type: 'base64', media_type: doc.mediaType, data: doc.data }
          })
        }
        content = blocks
      }
      const block = {
        type: 'tool_result' as const,
        tool_use_id: m.toolCallId ?? '',
        content: content as Anthropic.ToolResultBlockParam['content']
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
      if (m.images?.length) {
        const blocks: unknown[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const img of m.images) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data }
          })
        }
        out.push({ role: 'user', content: blocks as Anthropic.MessageParam['content'] })
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      // Thinking blocks must come first, before text and tool_use.
      const content: unknown[] = [...thinkingBlocks(m, thinkingEnabled)]
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

const EPHEMERAL = { type: 'ephemeral' as const }

/**
 * Add a prompt-cache breakpoint to the last content block of the last message.
 * Combined with caching the (static) system prompt + tools, this lets Anthropic
 * reuse the whole conversation prefix across the loop's iterations — each turn
 * only the newest content is uncached. Mutates in place; the message array is
 * freshly built per request so that's safe. Exported for testing.
 */
export function markMessagesCacheBreakpoint(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1]
  if (!last) return
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }]
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    const block = last.content[last.content.length - 1] as { cache_control?: typeof EPHEMERAL }
    block.cache_control = EPHEMERAL
  }
}

/** Extract reasoning blocks (with signatures) from a completed message, for replay. */
function reasoningFromMessage(content: Anthropic.ContentBlock[]): ReasoningBlock[] {
  const blocks: ReasoningBlock[] = []
  for (const b of content) {
    if (b.type === 'thinking') {
      blocks.push({ text: b.thinking, signature: b.signature })
    } else if (b.type === 'redacted_thinking') {
      blocks.push({ text: '', redactedData: b.data })
    }
  }
  return blocks
}

export function createAnthropicProvider(apiKey: string, baseURL?: string): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let clientPromise: Promise<Anthropic> | undefined
  const getClient = (): Promise<Anthropic> =>
    (clientPromise ??= import('@anthropic-ai/sdk').then(
      (m) => new m.default({ apiKey, ...(baseURL ? { baseURL } : {}) })
    ))

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const client = await getClient()
      const tools: Anthropic.Tool[] | undefined = req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema
      }))
      // Cache the (static) tool schemas: a breakpoint on the last tool covers them all.
      if (tools && tools.length) tools[tools.length - 1].cache_control = EPHEMERAL

      // Cache the (static) system prompt.
      const system: Anthropic.TextBlockParam[] | undefined = req.system
        ? [{ type: 'text', text: req.system, cache_control: EPHEMERAL }]
        : undefined

      const thinking = anthropicThinking(req.model, req.reasoningEffort)
      const messages = toAnthropicMessages(req.messages, thinking !== null)
      markMessagesCacheBreakpoint(messages)

      // With thinking, max_tokens must exceed the thinking budget.
      const maxTokens = thinking ? thinking.maxTokens : req.maxTokens ?? DEFAULT_MAX_TOKENS

      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...(tools && tools.length ? { tools } : {}),
          ...(thinking
            ? { thinking: { type: 'enabled' as const, budget_tokens: thinking.budgetTokens } }
            : {})
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
          } else if (delta.type === 'thinking_delta') {
            yield { type: 'reasoning', text: delta.thinking }
          } else if (delta.type === 'input_json_delta') {
            const buf = toolBuffers.get(event.index)
            if (buf) buf.json += delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          const buf = toolBuffers.get(event.index)
          if (buf) {
            let args: Record<string, unknown>
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
      const reasoning = reasoningFromMessage(final.content)
      // With caching, input_tokens counts only the *uncached* prefix; add the
      // cached reads/writes back so the reported context size stays accurate.
      const u = final.usage
      const inputTokens = u
        ? (u.input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0)
        : undefined
      yield {
        type: 'done',
        stopReason: mapStopReason(final.stop_reason),
        usage: {
          inputTokens,
          outputTokens: final.usage?.output_tokens
        },
        ...(reasoning.length ? { reasoning } : {})
      }
    }
  }
}

/** Fetch the live model list from the Anthropic API. */
export async function listAnthropicModels(apiKey: string, baseURL?: string): Promise<string[]> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
  const page = await client.models.list({ limit: 100 })
  return page.data.map((m) => m.id)
}
