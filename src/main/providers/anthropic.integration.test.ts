import { describe, it, expect } from 'vitest'
import { createAnthropicProvider } from './anthropic'
import { defaultProviders } from '@shared/defaults'

/**
 * Live canary against the real Anthropic API.
 *
 * OPT-IN ONLY: runs solely when ANTHROPIC_API_KEY is set, so a normal
 * `vitest run` (and CI without the secret) skip it cleanly — same pattern as
 * openai.integration.test.ts.
 *
 * Why it exists: offline unit tests can't catch Anthropic *removing* or renaming
 * a request parameter. That's exactly what bit us when Opus 4.7/4.8 dropped
 * `thinking: {type: 'enabled', budget_tokens}` and began returning 400 — every
 * mocked test still passed. This makes one tiny reasoning-enabled call per
 * shipped model and fails if the thinking / output_config shape Houston builds
 * is no longer accepted by that model.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... npm test -- anthropic.integration
 */
const API_KEY = process.env.ANTHROPIC_API_KEY

// Derive the model list from defaults so the canary tracks what Houston actually
// ships instead of drifting from a hard-coded copy.
const ANTHROPIC_MODELS =
  defaultProviders().find((p) => p.id === 'anthropic')?.models.map((m) => m.id) ?? []

describe.skipIf(!API_KEY)('anthropic reasoning (live API canary)', () => {
  // Guard against a defaults refactor silently emptying the list, which would
  // turn the canary into a no-op that always "passes".
  it('ships at least one Claude model to exercise', () => {
    expect(ANTHROPIC_MODELS.length).toBeGreaterThan(0)
  })

  it.each(ANTHROPIC_MODELS)(
    'accepts the reasoning request shape for %s',
    async (model) => {
      const provider = createAnthropicProvider(API_KEY!)
      let done = false
      // 'low' effort still sends the exact thinking/output_config shape (adaptive
      // for 4.6+, legacy budget for Haiku 4.5) while keeping token use minimal.
      // A removed/renamed parameter surfaces as a 400 — either an `error` event
      // or a throw from the stream iteration — and fails this test.
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
