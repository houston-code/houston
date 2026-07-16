import { describe, it, expect } from 'vitest'
import { createResponsesProvider } from './responses'
import { defaultProviders } from '@shared/defaults'

/**
 * Live canary against the real OpenAI API (Responses).
 *
 * OPT-IN ONLY: runs solely when OPENAI_API_KEY is set, so a normal `vitest run`
 * (and CI without the secret) skip it cleanly — same pattern as
 * anthropic.integration.test.ts.
 *
 * Why this covers `responses.ts` and not `openai.ts`: the built-in OpenAI provider
 * ships without a custom base URL, and providers/index.ts routes exactly that case
 * to `createResponsesProvider` — so the Responses API is the path real users on the
 * built-in provider actually hit. openai.integration.test.ts exercises
 * `createOpenAIProvider` (Chat Completions) against a *local* OpenAI-compatible
 * server, which is the proxy/gateway path (`kind: 'openai-compatible'`, or `openai`
 * with a baseUrl) — not the hosted one. Neither of those is a substitute for this.
 *
 * Why it exists: offline unit tests can't catch OpenAI *removing* or renaming a
 * request parameter — the mocks keep happily answering the old shape. That's the
 * class of bug that bit us when Opus 4.7/4.8 dropped the legacy thinking shape and
 * began returning 400 while every mocked test still passed. This makes one tiny
 * reasoning-enabled call per shipped model and fails if the
 * `reasoning: { effort, summary }` shape Houston builds (openaiResponsesReasoning)
 * is no longer accepted by that model.
 *
 *   OPENAI_API_KEY=sk-... npm test -- responses.integration
 */
const API_KEY = process.env.OPENAI_API_KEY

// Derive the model list from defaults so the canary tracks what Houston actually
// ships instead of drifting from a hard-coded copy. Every shipped id matches
// openaiSupportsReasoning (/^(o\d|gpt-5)/), so each one really does send `reasoning`.
const OPENAI_MODELS = defaultProviders().find((p) => p.id === 'openai')?.models.map((m) => m.id) ?? []

describe.skipIf(!API_KEY)('openai reasoning (live API canary)', () => {
  // Guard against a defaults refactor silently emptying the list, which would
  // turn the canary into a no-op that always "passes".
  it('ships at least one OpenAI model to exercise', () => {
    expect(OPENAI_MODELS.length).toBeGreaterThan(0)
  })

  it.each(OPENAI_MODELS)(
    'accepts the reasoning request shape for %s',
    async (model) => {
      const provider = createResponsesProvider(API_KEY!)
      let done = false
      // 'low' effort still sends the exact `reasoning: { effort, summary: 'auto' }`
      // shape while keeping token use minimal. A removed/renamed parameter (or a
      // model that's no longer served) surfaces as a 400/404 — either an `error`
      // event or a throw from the stream iteration — and fails this test.
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
