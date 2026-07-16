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
    /** Set on `response.failed`; the top-level `error` event carries these inline instead. */
    error?: { code?: string; message?: string }
  }
  code?: string
  message?: string
}

/**
 * Map a Responses error `code` onto the HTTP status it would have carried. The stream
 * reports failures in-band — the response was a 200 by the time it broke — so there's no
 * status on the wire, and without one the retry classifier has only prose to go on and
 * treats a transient overload as permanent.
 *
 * Deliberately narrow: only codes that are *always* transient map to a retryable status.
 * Anything else stays unmapped and so non-retryable, which is right — re-sending a
 * request the API rejected on its merits (`invalid_prompt`, `context_length_exceeded`)
 * just fails the same way.
 */
export function responsesErrorStatus(code: string | undefined): number | undefined {
  switch (code) {
    case 'rate_limit_exceeded':
      return 429
    case 'server_error':
      return 500
    default:
      return undefined
  }
}

/**
 * True for the specific 400 OpenAI returns when an *unverified organization* asks for
 * reasoning summaries: `param: 'reasoning.summary'`, `code: 'unsupported_value'`.
 *
 * Deliberately narrow. We only want to recover from "this org may not have summaries",
 * never from a genuinely malformed request — swallowing a broader class of 400 would
 * hide exactly the parameter drift the provider canary exists to catch.
 */
export function isSummaryUnsupportedError(err: unknown): boolean {
  const e = err as { status?: number; error?: { param?: string; code?: string } } | null
  return (
    !!e &&
    e.status === 400 &&
    e.error?.param === 'reasoning.summary' &&
    e.error?.code === 'unsupported_value'
  )
}

type ResponsesReasoning = NonNullable<ReturnType<typeof openaiResponsesReasoning>>

/** Drop `summary` from a reasoning config, keeping the effort that actually drives reasoning. */
function withoutSummary(reasoning: ResponsesReasoning): { effort: ResponsesReasoning['effort'] } {
  return { effort: reasoning.effort }
}

export function createResponsesProvider(apiKey: string | null, baseURL?: string): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let clientPromise: Promise<OpenAI> | undefined
  const getClient = (): Promise<OpenAI> =>
    (clientPromise ??= import('openai').then(
      (m) => new m.default({ apiKey: apiKey || 'no-key', ...(baseURL ? { baseURL } : {}) })
    ))

  // Sticky for this provider instance once OpenAI tells us this org can't have reasoning
  // summaries, so we send the request right the first time on later turns instead of
  // paying a rejected round-trip each one.
  let summaryUnsupported = false

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const client = await getClient()
      const configured = openaiResponsesReasoning(req.model, req.reasoningEffort, req.reasoningSummary)
      const reasoning = configured && summaryUnsupported ? withoutSummary(configured) : configured
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

      // Reasoning summaries are gated on organization verification, and that's a property of
      // the USER's org, not ours — an unverified org gets a hard 400 on every reasoning call
      // (o3 is the model that surfaced this). The effort is what actually drives reasoning;
      // the summary only makes it visible. So on exactly that error, retry once without the
      // summary: the user still gets a working turn, minus the streamed thinking, instead of
      // a dead model. Any other failure propagates untouched.
      const create = (p: Record<string, unknown>): Promise<AsyncIterable<unknown>> =>
        client.responses.create(p as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, {
          signal: req.signal
        }) as unknown as Promise<AsyncIterable<unknown>>

      let stream: AsyncIterable<unknown>
      try {
        stream = await create(params)
      } catch (err) {
        if (!reasoning || !isSummaryUnsupportedError(err)) throw err
        summaryUnsupported = true
        stream = await create({ ...params, reasoning: withoutSummary(reasoning) })
      }

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
          case 'error': {
            // `response.failed` nests its error under `response.error`; the top-level
            // `error` event carries the same fields inline. Reading only `ev.message`
            // saw neither on the former, so every failed response degraded to the
            // generic fallback below — losing the reason *and* the code that says
            // whether it's worth retrying.
            const failure = ev.response?.error ?? { code: ev.code, message: ev.message }
            const status = responsesErrorStatus(failure.code)
            yield {
              type: 'error',
              message: failure.message ?? 'OpenAI Responses API error',
              ...(status !== undefined ? { status } : {})
            }
            return
          }
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
