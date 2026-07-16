import type { Content, GoogleGenAI } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import type { ModelOption } from '@shared/types'
import { geminiThinkingBudget } from './reasoning'

export function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = []
  // Tracks whether the last emitted turn is a `user` turn built from tool
  // result(s), so a plain user turn that immediately follows (e.g. a mid-loop
  // stall/landing nudge pushed after a tool-using turn, or an interrupt/reconnect
  // that lands a user message right after a result) folds onto it. Gemini enforces
  // user/model alternation, so two consecutive `user` turns are a 400.
  let mergingToolResults = false
  for (const m of messages) {
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
        continue
      }
      mergingToolResults = false
      if (!parts!.length) parts!.push({ text: '' }) // Gemini rejects an empty parts array
      out.push({ role: 'user', parts })
    } else if (m.role === 'assistant') {
      mergingToolResults = false
      const parts: Content['parts'] = []
      if (m.content) parts!.push({ text: m.content })
      for (const tc of m.toolCalls ?? []) {
        parts!.push({ functionCall: { name: tc.name, args: tc.arguments } })
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
      // A functionResponse part can't share a turn with media (inlineData) parts,
      // so images a tool produced (e.g. a view_localhost screenshot) follow as
      // their own user turn for vision-capable models. (Text parts are fine to mix,
      // which is how a following nudge folds in above.)
      if (m.images?.length) {
        out.push({
          role: 'user',
          parts: m.images.map((img) => ({
            inlineData: { mimeType: img.mediaType, data: img.data }
          }))
        })
        // The image turn is its own `user` turn; a following nudge must not fold
        // into it (functionResponse + inlineData can't share a turn), so a fresh
        // user turn is correct there — stop merging.
        mergingToolResults = false
      }
    }
  }
  return out
}

export function createGeminiProvider(apiKey: string): Provider {
  // Load the SDK lazily (memoized) so it isn't parsed at startup — only when a
  // turn first runs. Providers the user never selects never pull their SDK in.
  let aiPromise: Promise<GoogleGenAI> | undefined
  const getAi = (): Promise<GoogleGenAI> =>
    (aiPromise ??= import('@google/genai').then((m) => new m.GoogleGenAI({ apiKey })))

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const ai = await getAi()
      const config: Record<string, unknown> = {}
      if (req.system) config.systemInstruction = req.system
      if (req.maxTokens) config.maxOutputTokens = req.maxTokens
      const thinkingBudget = geminiThinkingBudget(req.model, req.reasoningEffort)
      if (thinkingBudget !== undefined) {
        config.thinkingConfig = { thinkingBudget, includeThoughts: true }
      }
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
        contents: toGeminiContents(req.messages),
        config
      })

      let sawToolCall = false
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let cacheReadTokens: number | undefined
      let finishReason: string | undefined
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
            yield {
              type: 'tool_call',
              call: {
                id: part.functionCall.id || randomUUID(),
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
        }
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
