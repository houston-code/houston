import { describe, it, expect } from 'vitest'
import { createOpenAIProvider, listOpenAIModels } from './openai'

// Integration test against a local OpenAI-compatible server (e.g. Ollama).
//
// OPT-IN ONLY: it runs solely when CODERPRO_TEST_OPENAI_BASE is set. It used to
// auto-detect a reachable http://localhost:11434, which made the suite
// non-hermetic — it skipped in CI (nothing listening) but could *fail* on a
// contributor's machine that happened to have a server up that didn't speak the
// expected protocol or lacked the hard-coded model. Tests must not change
// behavior based on ambient state, so we require an explicit opt-in instead.
//
//   CODERPRO_TEST_OPENAI_BASE=http://localhost:11434/v1 npm test
//   # optionally pin a model; otherwise the first one the server lists is used:
//   CODERPRO_TEST_OPENAI_MODEL=llama3:latest
const BASE = process.env.CODERPRO_TEST_OPENAI_BASE
const MODEL = process.env.CODERPRO_TEST_OPENAI_MODEL

async function reachable(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

// Only run when explicitly opted in *and* the server actually answers, so an
// opted-in-but-down server skips cleanly instead of hanging the timeout.
const up = BASE ? await reachable(BASE) : false

describe.skipIf(!up)('openai-compatible adapter (live local server)', () => {
  // `up` is only true when BASE is set, so the non-null assertions below are safe.
  it('lists models', async () => {
    const models = await listOpenAIModels(null, BASE!)
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)
  })

  it('streams text and ends with a done event', async () => {
    // Use the pinned model, or fall back to whatever the server lists first, so
    // the test doesn't assume a specific model is installed.
    const model = MODEL ?? (await listOpenAIModels(null, BASE!))[0]
    expect(model, 'server reported no models').toBeTruthy()
    const provider = createOpenAIProvider(null, BASE!)
    let text = ''
    let done = false
    for await (const e of provider.streamChat({
      model: model!,
      system: 'You are a test fixture. Answer in one short word.',
      messages: [{ role: 'user', content: 'Reply with the single word: pong' }]
    })) {
      if (e.type === 'text') text += e.text
      if (e.type === 'done') done = true
      if (e.type === 'error') throw new Error(e.message)
    }
    expect(done).toBe(true)
    expect(text.trim().length).toBeGreaterThan(0)
  }, 60_000)
})
