import type OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent, StopReason } from '@shared/agent'
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

/** Map internal chat messages to Responses API input items. */
export function toResponsesInput(messages: ChatMessage[]): InputItem[] {
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
  item?: { type?: string; call_id?: string; name?: string; arguments?: string }
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
        input: toResponsesInput(req.messages),
        stream: true,
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
            if (item?.type === 'function_call') {
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
        }
      }
    }
  }
}
