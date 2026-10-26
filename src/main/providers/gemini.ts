import type { Content, GoogleGenAI, Part } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type {
  ChatMessage,
  ChatRequest,
  Provider,
  ProviderStreamEvent,
  ReasoningBlock
} from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { geminiThinkingConfig, geminiUsesThinkingLevel } from './reasoning'
import { idleTimeoutFetch } from './idle-fetch'

/** Output floor for models that always think (Gemini 4): Google's recommended minimum. */
const GEMINI_THINKING_MIN_OUTPUT = 32_768

/**
 * The thought signatures a turn's function calls carried, keyed by call id, for the
 * model the request goes to. A signature is bound to the model that issued it, so
 * after a fallback hop or a model switch the calls go back without one.
 */
function callSignatures(m: ChatMessage, model: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of m.reasoning ?? []) {
    if (r.id && r.signature && (!r.model || r.model === model)) out.set(r.id, r.signature)
  }
  return out
}

export function toGeminiContents(messages: ChatMessage[], model = ''): Content[] {
  const out: Content[] = []
  // Tracks whether the last emitted turn is a `user` turn built from tool
  // result(s), so a plain user turn that immediately follows (e.g. a mid-loop
  // stall/landing nudge pushed after a tool-using turn, or an interrupt/reconnect
  // that lands a user message right after a result) folds onto it. Gemini enforces
  // user/model alternation, so two consecutive `user` turns are a 400.
  let mergingToolResults = false
  // A functionResponse part can't share a turn with media (inlineData) parts, so
  // images a tool produced (e.g. a view_localhost screenshot) follow as their own
  // user turn for vision-capable models. They wait until the run of tool results
  // ends: the responses to one model turn's function calls must all sit in the next
  // turn, so an image turn between two parallel results is a 400 (the response
  // parts no longer match the call parts).
  let toolImages: Part[] = []
  // Whether the last emitted turn came from a plain user message (not tool results
  // or a tool's images), so a second plain user message can fold onto it.
  let lastPlainUser = false
  const flushToolImages = (): void => {
    if (!toolImages.length) return
    out.push({ role: 'user', parts: toolImages })
    toolImages = []
    // The image turn is its own `user` turn; a following nudge must not fold into
    // the tool-result turn behind it, so a fresh user turn is correct there.
    mergingToolResults = false
  }
  for (const m of messages) {
    if (m.role !== 'tool') flushToolImages()
    if (m.role !== 'user') lastPlainUser = false
    if (m.role === 'user') {
      const parts: Content['parts'] = []
      if (m.content) parts!.push({ text: m.content })
      for (const img of m.images ?? []) {
        parts!.push({ inlineData: { mimeType: img.mediaType, data: img.data } })
      }
      const last = out[out.length - 1]
      if (mergingToolResults && last?.parts) {
        // Fold onto the tool-result user turn, but ONLY text: a functionResponse part
        // can't share a turn with inlineData (a Gemini 400), so any images get their
        // own user turn, mirroring the tool-produced-image handling below. (Empty
        // content ⇒ nothing to add, but still drop it so it can't become a second
        // consecutive `user` turn.)
        const textParts = parts!.filter((p) => 'text' in p)
        const mediaParts = parts!.filter((p) => 'inlineData' in p)
        if (textParts.length) last.parts.push(...textParts)
        if (mediaParts.length) {
          out.push({ role: 'user', parts: mediaParts })
          mergingToolResults = false
        }
        lastPlainUser = false
        continue
      }
      mergingToolResults = false
      // Two plain user messages in a row (an automated note queued just ahead of the
      // user's message, or a forked history ending on a user turn before the hand-off
      // prompt) fold together, for the same alternation rule. Only onto a turn that
      // was itself a plain user message: never onto function responses (which can't
      // share a turn with inline media) or a tool's image turn (kept on its own).
      if (lastPlainUser && last?.parts) {
        last.parts.push(...parts!)
        continue
      }
      if (!parts!.length) parts!.push({ text: '' }) // Gemini rejects an empty parts array
      out.push({ role: 'user', parts })
      lastPlainUser = true
    } else if (m.role === 'assistant') {
      mergingToolResults = false
      const parts: Content['parts'] = []
      if (m.content) parts!.push({ text: m.content })
      // Thinking models (Gemini 3 and later) sign their function calls and reject a
      // request whose current-turn calls come back without the signature, so each
      // call is sent with the one it was issued with.
      const signatures = callSignatures(m, model)
      for (const tc of m.toolCalls ?? []) {
        const thoughtSignature = signatures.get(tc.id)
        parts!.push({
          functionCall: { name: tc.name, args: tc.arguments },
          ...(thoughtSignature ? { thoughtSignature } : {})
        })
      }
      out.push({ role: 'model', parts })
    } else if (m.role === 'tool') {
      const fnPart = {
        functionResponse: {
          name: m.toolName ?? '',
          response: { result: m.content }
        }
      }
      const last = out[out.length - 1]
      if (mergingToolResults && last?.parts) {
        last.parts.push(fnPart)
      } else {
        out.push({ role: 'user', parts: [fnPart] })
        mergingToolResults = true
      }
      for (const img of m.images ?? []) {
        toolImages.push({ inlineData: { mimeType: img.mediaType, data: img.data } })
      }
    }
  }
  flushToolImages()
  return out
}

export function createGeminiProvider(apiKey: string): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let aiPromise: Promise<GoogleGenAI> | undefined
  const getAi = (): Promise<GoogleGenAI> =>
    (aiPromise ??= import('@google/genai').then(
      (m) => new m.GoogleGenAI({ apiKey, httpOptions: { fetch: idleTimeoutFetch() } })
    ))

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const ai = await getAi()
      const config: Record<string, unknown> = {}
      if (req.system) config.systemInstruction = req.system
      if (req.maxTokens) {
        // Gemini 4 always thinks and spends the output limit on it: a short cap (a title, a
        // summary) can run out mid-thought with no answer. Google recommends at least 32K.
        config.maxOutputTokens = geminiUsesThinkingLevel(req.model)
          ? Math.max(req.maxTokens, GEMINI_THINKING_MIN_OUTPUT)
          : req.maxTokens
      }
      const thinkingConfig = geminiThinkingConfig(req.model, req.reasoningEffort)
      if (thinkingConfig) config.thinkingConfig = thinkingConfig
      if (req.tools && req.tools.length) {
        config.tools = [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters
            }))
          }
        ]
      }
      if (req.signal) config.abortSignal = req.signal

      const stream = await ai.models.generateContentStream({
        model: req.model,
        contents: toGeminiContents(req.messages, req.model),
        config
      })

      let sawToolCall = false
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let cacheReadTokens: number | undefined
      let finishReason: string | undefined
      // Function-call thought signatures, carried on the turn as reasoning blocks keyed
      // by call id so the next request can return each one (see toGeminiContents).
      const signatures: ReasoningBlock[] = []
      for await (const chunk of stream) {
        // usageMetadata is cumulative across the stream; keep the latest seen.
        const usage = chunk.usageMetadata
        if (usage) {
          inputTokens = usage.promptTokenCount
          // candidatesTokenCount EXCLUDES the model's "thoughts" (reasoning) tokens,
          // which Gemini bills at the output rate; add them so the output count and
          // cost aren't understated on 2.5 thinking requests (parity with the other
          // adapters, whose output_tokens already include reasoning).
          outputTokens = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
          // Implicit-cache hits (Gemini 2.5+ caches automatically). A subset of
          // promptTokenCount, billed below the input rate; implicit writes are free.
          cacheReadTokens = usage.cachedContentTokenCount
        }
        const cand = chunk.candidates?.[0]
        // Keep the latest finishReason so a truncated response is reported as such
        // instead of a clean end_turn (the loop's max-output handling depends on it).
        if (cand?.finishReason) finishReason = cand.finishReason
        // Iterate parts so we can separate "thought" parts (reasoning) from the
        // answer text — chunk.text would merge them.
        const parts = cand?.content?.parts ?? []
        for (const part of parts) {
          if (part.functionCall) {
            sawToolCall = true
            const id = part.functionCall.id || randomUUID()
            if (part.thoughtSignature) {
              signatures.push({ text: '', model: req.model, id, signature: part.thoughtSignature })
            }
            yield {
              type: 'tool_call',
              call: {
                id,
                name: part.functionCall.name ?? '',
                arguments: (part.functionCall.args as Record<string, unknown>) ?? {}
              }
            }
          } else if (part.text) {
            yield part.thought ? { type: 'reasoning', text: part.text } : { type: 'text', text: part.text }
          }
        }
      }

      yield {
        type: 'done',
        // A MAX_TOKENS cutoff means the reply was truncated at the output limit, which
        // the loop surfaces specially; report it even when a (partial) tool call was
        // seen. Otherwise a tool call means tool_use, and a plain finish is end_turn.
        stopReason:
          finishReason === 'MAX_TOKENS' ? 'max_tokens' : sawToolCall ? 'tool_use' : 'end_turn',
        usage: {
          inputTokens,
          outputTokens,
          ...(cacheReadTokens ? { cacheReadTokens } : {})
        },
        ...(signatures.length ? { reasoning: signatures } : {})
      }
    }
  }
}

/**
 * Map one entry from the Gemini models.list response into a ModelOption,
 * capturing the context window from `inputTokenLimit` when the API provides it
 * (the Gemini counterpart of `modelOptionFromListing` in openai.ts). An absent
 * or non-positive limit leaves `caps` off entirely, so the name-heuristics in
 * usage.ts take over. Returns null for a nameless entry.
 */
export function modelOptionFromGeminiListing(m: {
  name?: string
  inputTokenLimit?: number
}): ModelOption | null {
  const id = (m.name ?? '').replace(/^models\//, '')
  if (!id) return null
  if (typeof m.inputTokenLimit === 'number' && m.inputTokenLimit > 0) {
    return { id, caps: { contextWindow: m.inputTokenLimit } }
  }
  return { id }
}

/** Fetch the live model list from the Gemini API. */
export async function listGeminiModels(apiKey: string): Promise<ModelOption[]> {
  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey })
  const out: ModelOption[] = []
  const pager = await ai.models.list()
  for await (const m of pager) {
    const opt = modelOptionFromGeminiListing(m)
    if (opt) out.push(opt)
  }
  return out
}
