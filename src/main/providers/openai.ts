import type OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent, StopReason } from '@shared/agent'
import type { ModelCaps, ModelOption } from '@shared/types'
import { imageDataUrl } from '@shared/images'
import { openaiReasoningEffort } from './reasoning'
import { classifyLead, parseTextToolCalls } from './tool-call-fallback'
import { ControlTagScrubber } from './control-tag-scrubber'

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const m of messages) {
    if (m.role === 'user') {
      if (m.images?.length) {
        const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = []
        if (m.content) parts.push({ type: 'text', text: m.content })
        for (const img of m.images) {
          parts.push({ type: 'image_url', image_url: { url: imageDataUrl(img) } })
        }
        out.push({ role: 'user', content: parts })
      } else {
        out.push({ role: 'user', content: m.content })
      }
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
      // A tool message's content is text-only, so images a tool produced (e.g. a
      // view_localhost screenshot) follow as a user turn for vision-capable models.
      if (m.images?.length) {
        out.push({
          role: 'user',
          content: m.images.map((img) => ({
            type: 'image_url' as const,
            image_url: { url: imageDataUrl(img) }
          }))
        })
      }
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
export function createOpenAIProvider(
  apiKey: string | null,
  baseURL?: string,
  headers?: Record<string, string>
): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let clientPromise: Promise<OpenAI> | undefined
  const getClient = (): Promise<OpenAI> =>
    (clientPromise ??= import('openai').then(
      (m) =>
        new m.default({
          apiKey: apiKey || 'no-key',
          ...(baseURL ? { baseURL } : {}),
          ...(headers && Object.keys(headers).length ? { defaultHeaders: headers } : {})
        })
    ))

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const client = await getClient()
      const tools = req.tools?.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters }
      }))

      // o-series / gpt-5 accept reasoning_effort; other models reject it, so it's gated.
      const reasoningEffort = openaiReasoningEffort(req.model, req.reasoningEffort)

      const stream = await client.chat.completions.create(
        {
          model: req.model,
          messages: toOpenAIMessages(req.system, req.messages),
          stream: true,
          // Ask for a final usage-only chunk. Most OpenAI-compatible servers honour
          // this; those that don't simply never send it, which we handle gracefully.
          stream_options: { include_usage: true },
          ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
          ...(tools && tools.length ? { tools } : {})
        },
        { signal: req.signal }
      )

      // Accumulate streamed tool calls by their `index`.
      const toolAcc = new Map<number, { id: string; name: string; args: string }>()
      let finishReason: string | null = null
      let inputTokens: number | undefined
      let outputTokens: number | undefined

      // Some OpenAI-compatible servers (notably Ollama on certain model templates,
      // and historically whenever streaming) return a tool call as plain assistant
      // text instead of structured `tool_calls`. When the request offered tools,
      // hold content that *starts* like a tool call so we can recover it at the end
      // instead of streaming raw JSON the user can't act on; ordinary prose streams
      // as usual. With no tools offered there's nothing to recover, so never hold.
      const knownToolNames = new Set((req.tools ?? []).map((t) => t.name))
      let contentMode: 'undecided' | 'text' | 'hold' = knownToolNames.size ? 'undecided' : 'text'
      let heldContent = ''

      // Strip ChatML/Hermes control tags some local models leak into visible text
      // (e.g. a `<tool_response>…</tool_response>` echo). All emitted text flows
      // through it; the trailing flush below catches any tag split across the end.
      const scrubber = new ControlTagScrubber()

      for await (const chunk of stream) {
        // The usage-only chunk arrives last and has an empty `choices` array.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens
          outputTokens = chunk.usage.completion_tokens
        }
        const choice = chunk.choices[0]
        if (!choice) continue
        const delta = choice.delta
        if (delta?.content) {
          if (contentMode === 'text') {
            const clean = scrubber.push(delta.content)
            if (clean) yield { type: 'text', text: clean }
          } else {
            heldContent += delta.content
            if (contentMode === 'undecided') {
              const lead = heldContent.trimStart()
              const verdict = lead ? classifyLead(lead) : 'wait'
              if (verdict === 'tool') {
                contentMode = 'hold'
              } else if (verdict === 'text') {
                // Ordinary prose — commit to streaming and flush what we buffered.
                contentMode = 'text'
                const clean = scrubber.push(heldContent)
                if (clean) yield { type: 'text', text: clean }
                heldContent = ''
              }
              // 'wait' — ambiguous prefix; keep buffering until it resolves.
            }
          }
        }
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

      let hadToolCalls = toolAcc.size > 0
      for (const acc of toolAcc.values()) {
        let args: Record<string, unknown>
        try {
          args = acc.args ? JSON.parse(acc.args) : {}
        } catch {
          args = {}
        }
        yield { type: 'tool_call', call: { id: acc.id || randomUUID(), name: acc.name, arguments: args } }
      }

      // No structured tool calls, but the model may have written one as text.
      if (!hadToolCalls && knownToolNames.size && heldContent.trim()) {
        const recovered = parseTextToolCalls(heldContent, knownToolNames)
        if (recovered) {
          for (const c of recovered) {
            yield { type: 'tool_call', call: { id: randomUUID(), name: c.name, arguments: c.arguments } }
          }
          hadToolCalls = true
          heldContent = ''
        }
      }
      // Anything still held wasn't a recoverable tool call — surface it as text.
      if (heldContent) {
        const clean = scrubber.push(heldContent)
        if (clean) yield { type: 'text', text: clean }
      }
      // Emit any text the scrubber was holding back pending a possible split tag.
      const tail = scrubber.flush()
      if (tail) yield { type: 'text', text: tail }

      yield {
        type: 'done',
        stopReason: mapFinishReason(finishReason, hadToolCalls),
        usage: { inputTokens, outputTokens }
      }
    }
  }
}

/**
 * Map one entry from a `GET /models` response into a ModelOption, capturing
 * capability metadata when the host provides it. Plain OpenAI-compatible servers
 * return only `{ id }`, so `caps` stays undefined (heuristics take over). Rich
 * hosts (OpenRouter and look-alikes) add:
 *   - `context_length` (number)
 *   - `supported_parameters` (string[]): `tools`/`tool_choice`, `reasoning`/`include_reasoning`
 *   - `architecture.input_modalities` (string[]): `image` ⇒ vision
 * These fields aren't in the SDK's typed Model, so we read them off the raw object.
 */
export function modelOptionFromListing(raw: Record<string, unknown>): ModelOption {
  const id = String(raw.id ?? '')
  const caps: ModelCaps = {}

  const params = raw.supported_parameters
  if (Array.isArray(params)) {
    const has = (...names: string[]): boolean => names.some((n) => params.includes(n))
    caps.tools = has('tools', 'tool_choice')
    caps.reasoning = has('reasoning', 'include_reasoning', 'reasoning_effort')
  }

  const arch = raw.architecture
  if (arch && typeof arch === 'object') {
    const modalities = (arch as Record<string, unknown>).input_modalities
    if (Array.isArray(modalities)) caps.vision = modalities.includes('image')
  }

  if (typeof raw.context_length === 'number' && raw.context_length > 0) {
    caps.contextWindow = raw.context_length
  }

  return Object.keys(caps).length ? { id, caps } : { id }
}

/** Fetch the live model list (GET /models). Works for OpenAI and most compatible servers. */
export async function listOpenAIModels(
  apiKey: string | null,
  baseURL?: string,
  headers?: Record<string, string>
): Promise<ModelOption[]> {
  const { default: OpenAI } = await import('openai')
  const client = new OpenAI({
    apiKey: apiKey || 'no-key',
    ...(baseURL ? { baseURL } : {}),
    ...(headers && Object.keys(headers).length ? { defaultHeaders: headers } : {})
  })
  const page = await client.models.list()
  return page.data.map((m) => modelOptionFromListing(m as unknown as Record<string, unknown>))
}
