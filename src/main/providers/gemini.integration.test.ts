import { describe, it, expect } from 'vitest'
import { createGeminiProvider } from './gemini'
import { defaultProviders } from '@shared/defaults'

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
      let done = false
      // 'low' effort still sends the exact `thinkingConfig` shape on thinking-capable
      // models while keeping token use minimal. Unlike the Anthropic/Responses
      // providers, gemini.ts never yields an `error` event — a rejected parameter
      // surfaces as a THROW from the stream, which fails this test on its own. The
      // error check below is a safety net in case it grows one.
      for await (const e of provider.streamChat({
        model,
        system: 'You are a test fixture. Answer in one short word.',
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        reasoningEffort: 'low'
      })) {
        if (e.type === 'error') throw new Error(`${model}: ${e.message}`)
        if (e.type === 'done') done = true
      }
      expect(done, `${model} produced no done event`).toBe(true)
    },
    60_000
  )
})
