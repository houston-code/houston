import { GoogleGenAI } from '@google/genai'
import type { Content } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'
import { geminiThinkingBudget } from './reasoning'

function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: Content['parts'] = []
      if (m.content) parts!.push({ text: m.content })
      for (const img of m.images ?? []) {
        parts!.push({ inlineData: { mimeType: img.mediaType, data: img.data } })
      }
      if (!parts!.length) parts!.push({ text: '' }) // Gemini rejects an empty parts array
      out.push({ role: 'user', parts })
    } else if (m.role === 'assistant') {
      const parts: Content['parts'] = []
      if (m.content) parts!.push({ text: m.content })
      for (const tc of m.toolCalls ?? []) {
        parts!.push({ functionCall: { name: tc.name, args: tc.arguments } })
      }
      out.push({ role: 'model', parts })
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? '',
              response: { result: m.content }
            }
          }
        ]
      })
    }
  }
  return out
}

export function createGeminiProvider(apiKey: string): Provider {
  const ai = new GoogleGenAI({ apiKey })

  return {
    async *streamChat(req: ChatRequest): AsyncGenerator<ProviderStreamEvent> {
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
  const ai = new GoogleGenAI({ apiKey })
  const out: string[] = []
  const pager = await ai.models.list()
  for await (const m of pager) {
    const name = (m.name ?? '').replace(/^models\//, '')
    if (name) out.push(name)
  }
  return out
}
