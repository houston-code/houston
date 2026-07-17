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
 * Beta header that turns on interleaved thinking for legacy budget-thinking
 * models — the model then emits a fresh thinking block after each tool result
 * instead of reasoning only once at the start of the turn. Adaptive-thinking
 * models (4.6+) interleave automatically and must NOT be sent this header.
 */
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'

/**
 * Build the `thinking`/`redacted_thinking` content blocks that must lead an
 * assistant turn when extended thinking is enabled. Returns [] when thinking is
 * off or the turn has no (signed) reasoning to replay.
 */
function thinkingBlocks(m: ChatMessage, thinkingEnabled: boolean, model: string): unknown[] {
  if (!thinkingEnabled || !m.reasoning?.length) return []
  const blocks: unknown[] = []
  for (const r of m.reasoning) {
    // A signature authenticates the block to the model that issued it, so after a
    // fallback hop or a manual model switch it can't be replayed. Blocks with no
    // recorded origin predate the tag; replay those, as before.
    if (r.model && r.model !== model) continue
    if (r.redactedData) {
      blocks.push({ type: 'redacted_thinking', data: r.redactedData })
    } else if (r.signature) {
      blocks.push({ type: 'thinking', thinking: r.text, signature: r.signature })
    }
  }
  return blocks
}

export function toAnthropicMessages(
  messages: ChatMessage[],
  thinkingEnabled: boolean,
  model = ''
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

    if (m.role === 'user') {
      const blocks: unknown[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const img of m.images ?? []) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data }
        })
      }
      // A plain user turn that immediately follows tool result(s) — e.g. a
      // mid-loop stall/landing nudge pushed after a tool-using turn, or an
      // interrupt/reconnect that lands a user message right after a result — must
      // fold onto that same user turn: a tool_result and a following text/image
      // block are one valid user turn, but two consecutive `user` messages are a
      // 400. Merge as extra blocks, mirroring the consecutive-tool-result merge.
      const last = out[out.length - 1]
      if (mergingToolResults && last && Array.isArray(last.content)) {
        ;(last.content as unknown[]).push(...blocks)
        continue
      }
      mergingToolResults = false
      // No images ⇒ keep the compact string form the model (and cache) expects.
      if (m.images?.length) {
        out.push({ role: 'user', content: blocks as Anthropic.MessageParam['content'] })
      } else {
        out.push({ role: 'user', content: m.content })
      }
    } else if (m.role === 'assistant') {
      mergingToolResults = false
      // Thinking blocks must come first, before text and tool_use.
      const content: unknown[] = [...thinkingBlocks(m, thinkingEnabled, model)]
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

/**
 * Extract reasoning blocks (with signatures) from a completed message, for replay.
 * Each is tagged with the model that produced it so a later turn on a different
 * model doesn't try to replay state that only this one can authenticate.
 */
function reasoningFromMessage(content: Anthropic.ContentBlock[], model: string): ReasoningBlock[] {
  const blocks: ReasoningBlock[] = []
  for (const b of content) {
    if (b.type === 'thinking') {
      blocks.push({ text: b.thinking, model, signature: b.signature })
    } else if (b.type === 'redacted_thinking') {
      blocks.push({ text: '', model, redactedData: b.data })
    }
  }
  return blocks
}

/**
 * The client surface this adapter actually drives: `messages.stream`. The
 * first-party SDK client and the Bedrock/Vertex clients all extend `BaseAnthropic`
 * and expose the same `messages` resource, so typing the seam structurally lets
 * every Claude host share one adapter instead of forking the streaming, thinking,
 * caching and usage logic per host.
 */
export interface MessagesClient {
  messages: Pick<Anthropic['messages'], 'stream'>
}

/**
 * A provider over any Claude Messages client. `getClient` is called on the first
 * turn and should memoize — it's the seam each host uses to construct (and lazily
 * import) its own SDK client. See {@link createAnthropicProvider} for the
 * first-party host, and bedrock.ts / vertex.ts for the cloud-hosted ones.
 *
 * Everything downstream of the client is host-independent: the Messages wire
 * protocol, the thinking parameters, cache breakpoints and the usage split are
 * identical on all three, and `req.model` is already in the host's own id
 * convention (the caller stores it that way), so nothing here rewrites it.
 */
export function createMessagesProvider(getClient: () => Promise<MessagesClient>): Provider {
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
      const messages = toAnthropicMessages(req.messages, thinking !== null, req.model)
      markMessagesCacheBreakpoint(messages)

      // Thinking dictates max_tokens: legacy budget thinking needs room above the
      // budget; adaptive sizing keeps the reply's headroom unchanged (see reasoning.ts).
      const maxTokens = thinking ? thinking.maxTokens : req.maxTokens ?? DEFAULT_MAX_TOKENS

      const stream = client.messages.stream(
        {
          model: req.model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages,
          ...(tools && tools.length ? { tools } : {}),
          // Opus 4.7/4.8 (and Fable/Mythos) reject `{type:'enabled', budget_tokens}`
          // with a 400 — they require adaptive thinking + output_config.effort.
          ...(thinking?.kind === 'adaptive'
            ? {
                thinking: { type: 'adaptive' as const, display: thinking.display },
                output_config: { effort: thinking.effort }
              }
            : thinking?.kind === 'budget'
              ? { thinking: { type: 'enabled' as const, budget_tokens: thinking.budgetTokens } }
              : {})
        },
        {
          signal: req.signal,
          // Only legacy budget thinking needs the interleaved beta; adaptive
          // models reject/ignore it and interleave on their own.
          ...(thinking?.kind === 'budget' && thinking.interleaved
            ? { headers: { 'anthropic-beta': INTERLEAVED_THINKING_BETA } }
            : {})
        }
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
      const reasoning = reasoningFromMessage(final.content, req.model)
      // With caching, input_tokens counts only the *uncached* prefix; add the
      // cached reads/writes back so the reported context size stays accurate.
      // Surface the split too: cache reads bill at ~10% and cache writes at ~125%
      // of the input rate, so the cost estimate can price them instead of charging
      // the whole (cache-heavy) prefix at the full input rate.
      const u = final.usage
      const cacheReadTokens = u?.cache_read_input_tokens ?? 0
      const cacheWriteTokens = u?.cache_creation_input_tokens ?? 0
      const inputTokens = u ? (u.input_tokens ?? 0) + cacheReadTokens + cacheWriteTokens : undefined
      yield {
        type: 'done',
        stopReason: mapStopReason(final.stop_reason),
        usage: {
          inputTokens,
          outputTokens: final.usage?.output_tokens,
          ...(cacheReadTokens ? { cacheReadTokens } : {}),
          ...(cacheWriteTokens ? { cacheWriteTokens } : {})
        },
        ...(reasoning.length ? { reasoning } : {})
      }
    }
  }
}

/** A provider for the first-party Anthropic API, authenticated with an API key. */
export function createAnthropicProvider(
  apiKey: string,
  baseURL?: string,
  headers?: Record<string, string>
): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let clientPromise: Promise<Anthropic> | undefined
  const getClient = (): Promise<Anthropic> =>
    (clientPromise ??= import('@anthropic-ai/sdk').then(
      (m) =>
        new m.default({
          apiKey,
          ...(baseURL ? { baseURL } : {}),
          ...(headers && Object.keys(headers).length ? { defaultHeaders: headers } : {})
        })
    ))

  return createMessagesProvider(getClient)
}

/** Fetch the live model list from the Anthropic API. */
export async function listAnthropicModels(
  apiKey: string,
  baseURL?: string,
  headers?: Record<string, string>
): Promise<string[]> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(headers && Object.keys(headers).length ? { defaultHeaders: headers } : {})
  })
  const page = await client.models.list({ limit: 100 })
  return page.data.map((m) => m.id)
}
