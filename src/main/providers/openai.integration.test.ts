import { describe, it, expect } from 'vitest'
import { createOpenAIProvider, listOpenAIModels } from './openai'

// Integration test against a local OpenAI-compatible server (Ollama).
// Skipped automatically when no server is reachable (e.g. in CI).
const BASE = process.env.CODERPRO_TEST_OPENAI_BASE ?? 'http://localhost:11434/v1'
const MODEL = process.env.CODERPRO_TEST_OPENAI_MODEL ?? 'llama2:latest'

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch {
    return false
  }
}

const up = await reachable()

describe.skipIf(!up)('openai-compatible adapter (live local server)', () => {
  it('lists models', async () => {
    const models = await listOpenAIModels(null, BASE)
    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)
  })

  it('streams text and ends with a done event', async () => {
    const provider = createOpenAIProvider(null, BASE)
    let text = ''
    let done = false
    for await (const e of provider.streamChat({
      model: MODEL,
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
