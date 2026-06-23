import { GoogleGenAI } from '@google/genai'
import type { Content } from '@google/genai'
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ChatRequest, Provider, ProviderStreamEvent } from '@shared/agent'

function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', parts: [{ text: m.content }] })
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
        const text = chunk.text
        if (text) yield { type: 'text', text }
        const calls = chunk.functionCalls
        if (calls) {
          for (const fc of calls) {
            sawToolCall = true
            yield {
              type: 'tool_call',
              call: {
                id: fc.id || randomUUID(),
                name: fc.name ?? '',
                arguments: (fc.args as Record<string, unknown>) ?? {}
              }
            }
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
