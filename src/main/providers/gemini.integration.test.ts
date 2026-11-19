import { describe, it, expect } from 'vitest'
import type { ChatMessage, ProviderStreamEvent, ReasoningBlock, ToolCall, ToolSchema } from '@shared/agent'
import { createGeminiProvider, listGeminiModels } from './gemini'
import { defaultProviders } from '@shared/defaults'
import { CANARY_TEST_TIMEOUT_MS, runCanaryProbe } from './canary'

/**
 * Live canary against the real Gemini API.
 *
 * OPT-IN ONLY: runs solely when GEMINI_API_KEY is set, so a normal `vitest run`
 * (and CI without the secret) skip it cleanly — same pattern as
 * anthropic.integration.test.ts / responses.integration.test.ts.
 *
 * Why it exists: offline unit tests can't catch Google *removing* or renaming a
 * request parameter — the mocks keep happily answering the old shape. That's the
 * class of bug that bit us when Opus 4.7/4.8 dropped the legacy thinking shape and
 * began returning 400 while every mocked test still passed. Gemini has the same
 * exposure via `config.thinkingConfig = { thinkingBudget, includeThoughts }`, so
 * this makes one tiny call per shipped model and fails if that shape is no longer
 * accepted.
 *
 * Coverage note: the shipped defaults straddle the thinking gate
 * (`geminiSupportsThinking`, /2\.5|thinking/), so this exercises BOTH paths —
 * gemini-2.5-* send `thinkingConfig`, gemini-2.0-flash deliberately sends none.
 * A regression that made the gate send `thinkingConfig` to a model that rejects it
 * (or drop it from one that needs it) fails here.
 *
 *   GEMINI_API_KEY=... npm test -- gemini.integration
 */
const API_KEY = process.env.GEMINI_API_KEY

// Derive the model list from defaults so the canary tracks what Houston actually
// ships instead of drifting from a hard-coded copy.
const GEMINI_MODELS = defaultProviders().find((p) => p.id === 'gemini')?.models.map((m) => m.id) ?? []

describe.skipIf(!API_KEY)('gemini thinking (live API canary)', () => {
  // Guard against a defaults refactor silently emptying the list, which would
  // turn the canary into a no-op that always "passes".
  it('ships at least one Gemini model to exercise', () => {
    expect(GEMINI_MODELS.length).toBeGreaterThan(0)
  })

  it.each(GEMINI_MODELS)(
    'accepts the request shape for %s',
    async (model) => {
      const provider = createGeminiProvider(API_KEY!)
      // 'low' effort still sends the exact `thinkingConfig` shape on thinking-capable
      // models while keeping token use minimal. Unlike the Anthropic/Responses
      // providers, gemini.ts never yields an `error` event — a rejected parameter
      // surfaces as a THROW from the stream, which fails this test on its own
      // (runCanaryProbe also throws on an `error` event, in case it grows one).
      // runCanaryProbe bounds each attempt and retries only transient failures
      // (timeout, 429, 5xx); a 400/404 still fails on the first try. See canary.ts.
      const done = await runCanaryProbe(
        (signal) =>
          provider.streamChat({
            model,
            system: 'You are a test fixture. Answer in one short word.',
            messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
            reasoningEffort: 'low',
            signal
          }),
        { onRetry: (n, err) => console.warn(`${model}: transient failure, retry ${n}:`, err) }
      )
      expect(done, `${model} produced no done event`).toBe(true)
    },
    CANARY_TEST_TIMEOUT_MS
  )
})

/** Pass a stream through unchanged, showing each event to `see` on the way. */
async function* tap(
  events: AsyncIterable<ProviderStreamEvent>,
  see: (e: ProviderStreamEvent) => void
): AsyncGenerator<ProviderStreamEvent> {
  for await (const e of events) {
    see(e)
    yield e
  }
}

const GET_TIME: ToolSchema = {
  name: 'get_time',
  description: 'Returns the current local time in a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
}

describe.skipIf(!API_KEY)('gemini tools and listing (live API canary)', () => {
  // The agent loop's own path: a turn that calls a tool, then the same calls sent back
  // with their results. Thinking models sign their function calls and reject a follow-up
  // whose calls come back unsigned, so this also proves the signature round-trips on the
  // API version Houston pins (and that `parametersJsonSchema` tool declarations are served).
  it.each(GEMINI_MODELS)(
    'round-trips a tool call for %s',
    async (model) => {
      const provider = createGeminiProvider(API_KEY!)
      const system = 'You are a test fixture. Use the get_time tool to answer questions about the time.'
      const ask: ChatMessage = { role: 'user', content: 'What time is it in Paris right now?' }
      let calls: ToolCall[] = []
      let reasoning: ReasoningBlock[] = []
      const first = await runCanaryProbe((signal) => {
        calls = []
        reasoning = []
        return tap(
          provider.streamChat({ model, system, messages: [ask], tools: [GET_TIME], reasoningEffort: 'low', signal }),
          (e) => {
            if (e.type === 'tool_call') calls.push(e.call)
            if (e.type === 'done') reasoning = e.reasoning ?? []
          }
        )
      })
      expect(first, `${model} produced no done event`).toBe(true)
      expect(calls.map((c) => c.name), `${model} did not call the tool`).toContain('get_time')

      const followUp: ChatMessage[] = [
        ask,
        { role: 'assistant', content: '', toolCalls: calls, reasoning },
        ...calls.map((c): ChatMessage => ({ role: 'tool', content: '14:05', toolCallId: c.id, toolName: c.name }))
      ]
      let answer = ''
      const second = await runCanaryProbe((signal) => {
        answer = ''
        return tap(
          provider.streamChat({ model, system, messages: followUp, tools: [GET_TIME], reasoningEffort: 'low', signal }),
          (e) => {
            if (e.type === 'text') answer += e.text
          }
        )
      })
      expect(second, `${model} produced no done event after the tool result`).toBe(true)
      expect(answer.length, `${model} gave no answer after the tool result`).toBeGreaterThan(0)
    },
    2 * CANARY_TEST_TIMEOUT_MS
  )

  it(
    'lists the shipped models',
    async () => {
      const listed = new Set((await listGeminiModels(API_KEY!)).map((m) => m.id))
      expect(listed.size).toBeGreaterThan(0)
      // The live list is not proof a model serves (see defaults.ts), only that the
      // listing endpoint answers on this API version; the default must be on it.
      const fallback = defaultProviders().find((p) => p.id === 'gemini')?.defaultModel
      expect(fallback && listed.has(fallback), `${fallback} missing from the listing`).toBe(true)
    },
    CANARY_TEST_TIMEOUT_MS
  )
})

