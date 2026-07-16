import type OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatRequest,
  Provider,
  ProviderStreamEvent,
  ReasoningBlock,
  StopReason
} from '@shared/agent'
import { imageDataUrl } from '@shared/images'
import { openaiResponsesReasoning } from './reasoning'

/**
 * Adapter for OpenAI's **Responses API** (`client.responses.create`), the path
 * OpenAI now requires for GPT-5 / o-series models (Chat Completions was removed
 * for Codex/`wire_api`). Compared to the Chat Completions adapter it streams
 * reasoning **summaries** (shown live), reports usage from the `response.completed`
 * event, and carries tool calls / results as native `function_call` /
 * `function_call_output` input items.
 *
 * Only used for the native OpenAI endpoint; OpenAI-*compatible* servers (Ollama,
 * LM Studio, proxies) stay on the Chat Completions adapter in `openai.ts`.
 */

type InputItem = Record<string, unknown>

/**
 * Rebuild the `reasoning` input items for an assistant turn.
 *
 * Reasoning models keep their chain of thought in server-side state keyed to a
 * response. Houston is stateless — it resends the whole conversation each turn and
 * never uses `previous_response_id` — so the state has to travel with the request as
 * `encrypted_content` (see `store: false` + `include` in `streamChat`). Without this,
 * every tool call throws away the model's reasoning and it re-derives its plan from
 * scratch on the next turn.
 *
 * Only blocks that actually carry `encryptedContent` are replayed: an `id` alone
 * points at a response we asked OpenAI not to store, which is a 400. Returns [] when
 * replay is off or the turn has no encrypted reasoning.
 */
function reasoningItems(m: ChatMessage, replay: boolean): InputItem[] {
  if (!replay || !m.reasoning?.length) return []
  const items: InputItem[] = []
  for (const r of m.reasoning) {
    if (!r.id || !r.encryptedContent) continue
    items.push({
      type: 'reasoning',
      id: r.id,
      encrypted_content: r.encryptedContent,
      // Display-only metadata; `encrypted_content` is the authoritative state. Sent
      // back so the item round-trips in the shape the API returned it.
      summary: r.text ? [{ type: 'summary_text', text: r.text }] : []
    })
  }
  return items
}

/**
 * Map internal chat messages to Responses API input items.
 *
 * `replayReasoning` should track whether reasoning is enabled for *this* request:
 * when the user switches to a non-reasoning model, its blocks must not be replayed.
 */
export function toResponsesInput(messages: ChatMessage[], replayReasoning = false): InputItem[] {
  const input: InputItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const content: InputItem[] = []
      if (m.content) content.push({ type: 'input_text', text: m.content })
      for (const img of m.images ?? []) {
        content.push({ type: 'input_image', image_url: imageDataUrl(img), detail: 'auto' })
      }
      input.push({ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '' }] })
    } else if (m.role === 'assistant') {
      // Reasoning leads the turn, mirroring the order the API emitted it: the
      // reasoning item precedes the message and function calls it produced.
      input.push(...reasoningItems(m, replayReasoning))
      if (m.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: m.content }] })
      }
      for (const tc of m.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        })
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.toolCallId ?? '', output: m.content })
      // A function_call_output's output is text-only, so images a tool produced
      // (e.g. a view_localhost screenshot) follow as a user turn — the documented
      // way to hand a tool's image to the model.
      if (m.images?.length) {
        input.push({
          role: 'user',
          content: m.images.map((img) => ({
            type: 'input_image',
            image_url: imageDataUrl(img),
            detail: 'auto'
          }))
        })
      }
    }
  }
  return input
}

/** Map internal tool schemas to Responses API function tools (flat, not nested). */
export function toResponsesTools(tools: ChatRequest['tools']): InputItem[] | undefined {
  if (!tools?.length) return undefined
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false
  }))
}

/** A loosely-typed view of the streamed Responses events we care about. */
interface ResponsesEvent {
  type: string
  delta?: string
  item?: {
    type?: string
    call_id?: string
    name?: string
    arguments?: string
    /** Reasoning items: `rs_...` id, encrypted state, and the display summary. */
    id?: string
    encrypted_content?: string | null
    summary?: { text?: string }[]
  }
  response?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      /** Prompt-cache read split; `cached_tokens` is a subset of `input_tokens`. */
      input_tokens_details?: { cached_tokens?: number }
    }
    incomplete_details?: { reason?: string } | null
  }
  message?: string
}

export function createResponsesProvider(apiKey: string | null, baseURL?: string): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let clientPromise: Promise<OpenAI> | undefined
  const getClient = (): Promise<OpenAI> =>
    (clientPromise ??= import('openai').then(
      (m) => new m.default({ apiKey: apiKey || 'no-key', ...(baseURL ? { baseURL } : {}) })
    ))

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const client = await getClient()
      const reasoning = openaiResponsesReasoning(req.model, req.reasoningEffort, req.reasoningSummary)
      const tools = toResponsesTools(req.tools)

      const params = {
        model: req.model,
        ...(req.system ? { instructions: req.system } : {}),
        input: toResponsesInput(req.messages, reasoning !== undefined),
        stream: true,
        // Houston resends the whole conversation each turn and never reads a
        // response back by id, so server-side storage buys nothing and would
        // retain the conversation on OpenAI's side for no reason. Opting out
        // makes the run stateless — which is exactly why reasoning state has to
        // come back to us encrypted, below.
        store: false,
        // The counterpart to `store: false`: without this the reasoning items
        // arrive with no `encrypted_content`, leaving nothing to replay.
        ...(reasoning ? { include: ['reasoning.encrypted_content'] } : {}),
        // The Responses API spells the reply cap `max_output_tokens`; it covers
        // reasoning tokens as well as visible output, and the stream reports
        // hitting it as `incomplete_details.reason === 'max_output_tokens'`.
        ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
        ...(tools ? { tools } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...(req.verbosity ? { text: { verbosity: req.verbosity } } : {})
      }

      const stream = await client.responses.create(
        params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
        { signal: req.signal }
      )

      let hadToolCalls = false
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let cacheReadTokens: number | undefined
      let stopReason: StopReason = 'end_turn'
      const turnReasoning: ReasoningBlock[] = []

      for await (const event of stream) {
        const ev = event as unknown as ResponsesEvent
        switch (ev.type) {
          case 'response.output_text.delta':
            if (ev.delta) yield { type: 'text', text: ev.delta }
            break
          case 'response.reasoning_summary_text.delta':
            if (ev.delta) yield { type: 'reasoning', text: ev.delta }
            break
          case 'response.output_item.done': {
            const item = ev.item
            if (item?.type === 'reasoning') {
              // Keep the item only if it carries replayable state; the summary is
              // for display. An id with no encrypted_content can't be sent back
              // (see `reasoningItems`), so there's nothing worth holding.
              if (item.id && item.encrypted_content) {
                turnReasoning.push({
                  text: (item.summary ?? []).map((s) => s.text ?? '').join(''),
                  id: item.id,
                  encryptedContent: item.encrypted_content
                })
              }
            } else if (item?.type === 'function_call') {
              hadToolCalls = true
              let args: Record<string, unknown>
              try {
                args = item.arguments ? JSON.parse(item.arguments) : {}
              } catch {
                args = {}
              }
              yield {
                type: 'tool_call',
                call: { id: item.call_id || randomUUID(), name: item.name || '', arguments: args }
              }
            }
            break
          }
          case 'response.completed': {
            const u = ev.response?.usage
            inputTokens = u?.input_tokens
            outputTokens = u?.output_tokens
            // OpenAI caches automatically (no opt-in) and bills reads below the
            // input rate; writes are free, so there's no write counterpart here.
            cacheReadTokens = u?.input_tokens_details?.cached_tokens
            if (ev.response?.incomplete_details?.reason === 'max_output_tokens') stopReason = 'max_tokens'
            break
          }
          case 'response.failed':
          case 'error':
            yield { type: 'error', message: ev.message ?? 'OpenAI Responses API error' }
            return
        }
      }

      yield {
        type: 'done',
        stopReason: hadToolCalls ? 'tool_use' : stopReason,
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens ? { cacheReadTokens } : {})
        },
        ...(turnReasoning.length ? { reasoning: turnReasoning } : {})
      }
    }
  }
}
