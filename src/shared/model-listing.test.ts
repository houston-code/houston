import { describe, it, expect } from 'vitest'
import { isLikelyChatModel, missingModelFacts, summarizeFetch } from './model-listing'

describe('isLikelyChatModel', () => {
  it('keeps chat models', () => {
    // "live" only as its own segment: a name merely containing the letters stays.
    for (const id of ['claude-opus-5-5', 'gpt-6.1-sol', 'o3', 'gemini-3.8-flash', 'llama3.1:latest', 'olive-7b']) {
      expect(isLikelyChatModel(id), id).toBe(true)
    }
  })

  it('drops embeddings, speech, image, moderation, legacy completions and realtime variants', () => {
    for (const id of [
      'text-embedding-3-large',
      'tts-1',
      'whisper-1',
      'gpt-4o-transcribe',
      'dall-e-3',
      'gpt-image-1',
      'imagen-4',
      'omni-moderation-latest',
      'davinci-002',
      'gpt-4o-realtime-preview',
      'gpt-4o-audio-preview',
      'gpt-4o-search-preview',
      // Streaming voice models, as the first live drift run listed them.
      'gpt-live-1',
      'gemini-3.8-live',
      'gemini-3.8-live-extended-thinking',
      'gemini-3.5-live-translate-preview'
    ]) {
      expect(isLikelyChatModel(id), id).toBe(false)
    }
  })

  it('drops dated snapshots of models that also have an undated id', () => {
    expect(isLikelyChatModel('gpt-5-2025-08-07')).toBe(false)
    expect(isLikelyChatModel('claude-opus-4-20250514')).toBe(false)
    expect(isLikelyChatModel('claude-opus-4-5@20251101')).toBe(false)
  })
})

describe('missingModelFacts', () => {
  it('is empty for a model this build fully recognizes', () => {
    expect(missingModelFacts('anthropic', { id: 'claude-opus-5-5' })).toEqual([])
  })

  it('names what an unknown first-party id lacks', () => {
    expect(missingModelFacts('openai', { id: 'gpt-omega' })).toEqual(['price', 'context window', 'family'])
  })

  it('counts host-listed metadata, so an aggregator entry with listed facts is recognized', () => {
    expect(
      missingModelFacts('openai', {
        id: 'gpt-7-sol',
        caps: { inputPrice: 1, outputPrice: 2, contextWindow: 2_000_000 }
      })
    ).toEqual([])
  })
})

describe('summarizeFetch', () => {
  it('reports what a fetch added and dropped', () => {
    const s = summarizeFetch(
      'anthropic',
      [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }],
      [{ id: 'claude-haiku-4-5' }, { id: 'claude-opus-5-5' }]
    )
    expect(s).toEqual({ total: 2, added: ['claude-opus-5-5'], removed: ['claude-opus-4-8'], unrecognised: [] })
  })

  it('flags newly added first-party chat models this build does not recognize, and nothing else', () => {
    const s = summarizeFetch(
      'openai',
      [{ id: 'gpt-6.1-sol' }],
      [
        { id: 'gpt-6.1-sol' }, // already there: not news
        { id: 'gpt-omega' }, // new, unknown: flagged
        { id: 'gpt-6-luna' }, // new, recognized
        { id: 'tts-omega' } // new but not a chat model
      ]
    )
    expect(s.added).toEqual(['gpt-omega', 'gpt-6-luna', 'tts-omega'])
    expect(s.unrecognised).toEqual(['gpt-omega'])
  })

  it('never flags an OpenAI-compatible host, whose open models the id rules are not meant to cover', () => {
    const s = summarizeFetch('openai-compatible', [], [{ id: 'qwen2.5-coder' }, { id: 'mystery-model' }])
    expect(s.added).toHaveLength(2)
    expect(s.unrecognised).toEqual([])
  })
})
