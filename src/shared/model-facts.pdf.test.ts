import { describe, expect, it } from 'vitest'
import { modelHasVision, providerAcceptsPdf } from './model-facts'

describe('providerAcceptsPdf', () => {
  it('is true on every Claude host, whose request builder sends document blocks', () => {
    for (const kind of ['anthropic', 'bedrock', 'vertex', 'foundry'] as const) {
      expect(providerAcceptsPdf(kind, 'claude-sonnet-5', false)).toBe(true)
    }
  })

  it('is true for multimodal models on hosted OpenAI (Responses input_file) and Gemini (inline data)', () => {
    expect(modelHasVision('gpt-5.5')).toBe(true)
    expect(providerAcceptsPdf('openai', 'gpt-5.5', false)).toBe(true)
    expect(modelHasVision('gemini-3-pro')).toBe(true)
    expect(providerAcceptsPdf('gemini', 'gemini-3-pro', false)).toBe(true)
  })

  it('is false where no document part is serialized', () => {
    // A base URL routes hosted OpenAI to Chat Completions.
    expect(providerAcceptsPdf('openai', 'gpt-5.5', true)).toBe(false)
    expect(providerAcceptsPdf('openai-compatible', 'gpt-5.5', true)).toBe(false)
    expect(providerAcceptsPdf('azure-openai', 'gpt-5.5', false)).toBe(false)
  })

  it('is false for a model the id rules do not know to be multimodal', () => {
    expect(providerAcceptsPdf('openai', 'some-text-only-model', false)).toBe(false)
    expect(providerAcceptsPdf('gemini', 'not-a-gemini-model', false)).toBe(false)
  })
})
