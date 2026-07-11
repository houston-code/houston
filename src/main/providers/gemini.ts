import type { Content, GoogleGenAI } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
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
        // Fold onto the tool-result user turn (empty content ⇒ nothing to add, but
        // still drop it so it can't become a second consecutive `user` turn).
        if (parts!.length) last.parts.push(...parts!)
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
      for await (const chunk of stream) {
        // usageMetadata is cumulative across the stream; keep the latest seen.
        const usage = chunk.usageMetadata
        if (usage) {
          inputTokens = usage.promptTokenCount
          outputTokens = usage.candidatesTokenCount
        }
        // Iterate parts so we can separate "thought" parts (reasoning) from the
        // answer text — chunk.text would merge them.
        const parts = chunk.candidates?.[0]?.content?.parts ?? []
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
        stopReason: sawToolCall ? 'tool_use' : 'end_turn',
        usage: { inputTokens, outputTokens }
      }
    }
  }
}

/** Fetch the live model list from the Gemini API. */
export async function listGeminiModels(apiKey: string): Promise<string[]> {
  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey })
  const out: string[] = []
  const pager = await ai.models.list()
  for await (const m of pager) {
    const name = (m.name ?? '').replace(/^models\//, '')
    if (name) out.push(name)
  }
  return out
}
