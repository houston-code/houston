import { describe, expect, it, vi } from 'vitest'
import { defaultProviders } from './defaults'
import { SMALL_MODELS, curatedSmallModel } from './model-facts'
import { BEDROCK_MODELS, FOUNDRY_MODELS, VERTEX_MODELS } from './provider-catalog'
import { SMALL_MODEL_SAME_AS_CHAT, automaticSmallModel, smallModelFor, withSmallModel } from './smallModel'
import type { ProviderConfig } from './types'

const anthropic = (over: Partial<ProviderConfig> = {}): Pick<ProviderConfig, 'kind' | 'smallModel' | 'models'> => ({
  kind: 'anthropic',
  models: [{ id: 'claude-opus-5-5' }, { id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }],
  ...over
})

describe('curated small models', () => {
  it('ships each one in its kind\'s own model list, so the automatic pick resolves', () => {
    const lists: Record<string, string[]> = {
      bedrock: BEDROCK_MODELS,
      vertex: VERTEX_MODELS,
      foundry: FOUNDRY_MODELS,
      ...Object.fromEntries(defaultProviders().map((p) => [p.kind, p.models.map((m) => m.id)]))
    }
    for (const [kind, id] of Object.entries(SMALL_MODELS)) {
      expect(lists[kind], kind).toContain(id)
    }
  })

  it('has none for hosts whose ids are the user\'s own', () => {
    expect(curatedSmallModel('openai-compatible')).toBeNull()
    expect(curatedSmallModel('azure-openai')).toBeNull()
  })
})

describe('smallModelFor', () => {
  it('picks the curated sibling for a pricier chat model', () => {
    expect(smallModelFor(anthropic(), 'claude-opus-5-5')).toBe('claude-haiku-5-5')
    expect(smallModelFor({ kind: 'openai', models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] }, 'gpt-6.1-sol')).toBe(
      'gpt-6-luna'
    )
  })

  it('keeps the chat model when it is the sibling, or already cheaper', () => {
    expect(smallModelFor(anthropic(), 'claude-haiku-5-5')).toBeNull()
    expect(
      smallModelFor({ kind: 'openai', models: [{ id: 'gpt-5-nano' }, { id: 'gpt-6-luna' }] }, 'gpt-5-nano')
    ).toBeNull()
  })

  it('needs the sibling in the provider\'s model list', () => {
    expect(smallModelFor(anthropic({ models: [{ id: 'claude-opus-5-5' }] }), 'claude-opus-5-5')).toBeNull()
  })

  it('has nothing automatic for a host without a curated sibling', () => {
    expect(smallModelFor({ kind: 'openai-compatible', models: [{ id: 'qwen' }, { id: 'tiny' }] }, 'qwen')).toBeNull()
  })

  it('follows an explicit choice, and "" means the chat model', () => {
    expect(smallModelFor(anthropic({ smallModel: 'claude-sonnet-5-5' }), 'claude-opus-5-5')).toBe('claude-sonnet-5-5')
    expect(smallModelFor(anthropic({ smallModel: 'claude-opus-5-5' }), 'claude-opus-5-5')).toBeNull()
    expect(smallModelFor(anthropic({ smallModel: SMALL_MODEL_SAME_AS_CHAT }), 'claude-opus-5-5')).toBeNull()
    expect(smallModelFor({ kind: 'openai-compatible', smallModel: 'tiny', models: [] }, 'qwen')).toBe('tiny')
  })

  it('names the automatic pick for the settings control', () => {
    expect(automaticSmallModel(anthropic())).toBe('claude-haiku-5-5')
    expect(automaticSmallModel({ kind: 'openai-compatible', models: [] })).toBeNull()
  })
})

describe('withSmallModel', () => {
  it('runs on the small model when it answers', async () => {
    const call = vi.fn(async (m: string) => `title from ${m}`)
    expect(await withSmallModel('small', 'big', call)).toBe('title from small')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('falls back to the chat model on an error or an empty answer', async () => {
    const failing = vi.fn(async (m: string) => {
      if (m === 'small') throw new Error('model not found')
      return 'ok'
    })
    expect(await withSmallModel('small', 'big', failing)).toBe('ok')
    expect(failing.mock.calls.map((c) => c[0])).toEqual(['small', 'big'])
    const empty = vi.fn(async (m: string) => (m === 'small' ? null : 'ok'))
    expect(await withSmallModel('small', 'big', empty)).toBe('ok')
  })

  it('keeps an empty answer when asked to', async () => {
    const call = vi.fn(async () => null)
    expect(await withSmallModel('small', 'big', call, undefined, { retryEmpty: false })).toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('never retries after an abort', async () => {
    const abort = new AbortController()
    const call = vi.fn(async () => {
      abort.abort()
      throw new Error('aborted')
    })
    await expect(withSmallModel('small', 'big', call, abort.signal)).rejects.toThrow('aborted')
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('runs once on the chat model when there is no small model', async () => {
    const call = vi.fn(async (m: string) => m)
    expect(await withSmallModel(null, 'big', call)).toBe('big')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
