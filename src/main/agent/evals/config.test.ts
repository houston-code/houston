import { describe, expect, it } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import {
  DEFAULT_LIVE_ATTEMPTS,
  SCRIPTED_MODEL,
  envOr,
  resolveEvalConfig,
  type Env
} from './config'

const providers = [
  { id: 'anthropic', kind: 'anthropic', label: 'Anthropic', models: [], defaultModel: 'claude-opus-4-8' },
  { id: 'nodefault', kind: 'openai-compatible', label: 'No default', models: [] }
] as unknown as ProviderConfig[]

const live = (env: Env = {}): Env => ({ HOUSTON_EVAL_LIVE: '1', ...env })

describe('envOr', () => {
  it('returns the value when set', () => {
    expect(envOr({ A: 'x' }, 'A', 'fallback')).toBe('x')
  })

  it('falls back when unset', () => {
    expect(envOr({}, 'A', 'fallback')).toBe('fallback')
  })

  // THE bug: `??` returns '' here, silently skipping every default downstream.
  it('treats an empty env var as unset', () => {
    expect(envOr({ A: '' }, 'A', 'fallback')).toBe('fallback')
  })

  it('treats a whitespace-only env var as unset', () => {
    expect(envOr({ A: '   ' }, 'A', 'fallback')).toBe('fallback')
  })

  it('trims a set value', () => {
    expect(envOr({ A: '  x  ' }, 'A', 'fallback')).toBe('x')
  })
})

describe('resolveEvalConfig', () => {
  it('defaults to the scripted driver', () => {
    expect(resolveEvalConfig({}, providers)).toEqual({
      live: false,
      record: false,
      providerId: 'anthropic',
      model: SCRIPTED_MODEL,
      attempts: 1
    })
  })

  it('resolves the provider default model in live mode', () => {
    expect(resolveEvalConfig(live(), providers).model).toBe('claude-opus-4-8')
  })

  /**
   * REGRESSION (the all-zero baseline incident). GitHub Actions' `env: FOO: ${{
   * inputs.foo || '' }}` sets the var to '' on a scheduled run, and the old `??`
   * let that through as the model id. Every live call then failed and
   * `eval:baseline` recorded 0 for all eight tasks — a permanently dead gate.
   */
  it('falls back to the default model when HOUSTON_EVAL_MODEL is set but EMPTY', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_MODEL: '' }), providers).model).toBe('claude-opus-4-8')
  })

  it('falls back to the default provider when HOUSTON_EVAL_PROVIDER is set but EMPTY', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_PROVIDER: '' }), providers).providerId).toBe('anthropic')
  })

  it('honors an explicit model', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_MODEL: 'claude-haiku-4-5' }), providers).model).toBe(
      'claude-haiku-4-5'
    )
  })

  it('never resolves an empty model id in live mode', () => {
    // Both spellings of "no model available" must throw, never yield ''.
    expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_PROVIDER: 'nodefault' }), providers)).toThrow(
      /No model to evaluate/
    )
  })

  it('rejects an unknown provider with the known ids', () => {
    expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_PROVIDER: 'nope' }), providers)).toThrow(
      /not a known provider id.*anthropic/s
    )
  })

  it('ignores the provider check in scripted mode', () => {
    // Scripted never reaches an adapter, so an odd provider id is harmless.
    expect(resolveEvalConfig({ HOUSTON_EVAL_PROVIDER: 'whatever' }, providers).model).toBe(SCRIPTED_MODEL)
  })

  describe('attempts', () => {
    it('defaults to 1 scripted and 3 live', () => {
      expect(resolveEvalConfig({}, providers).attempts).toBe(1)
      expect(resolveEvalConfig(live(), providers).attempts).toBe(DEFAULT_LIVE_ATTEMPTS)
    })

    it('honors an explicit count', () => {
      expect(resolveEvalConfig(live({ HOUSTON_EVAL_ATTEMPTS: '5' }), providers).attempts).toBe(5)
    })

    // Same empty-env-var trap: the workflow interpolates this one too.
    it('falls back when set but empty', () => {
      expect(resolveEvalConfig(live({ HOUSTON_EVAL_ATTEMPTS: '' }), providers).attempts).toBe(
        DEFAULT_LIVE_ATTEMPTS
      )
    })

    it.each(['0', '-1', '1.5', 'three'])('rejects %s rather than silently defaulting', (raw) => {
      expect(() => resolveEvalConfig(live({ HOUSTON_EVAL_ATTEMPTS: raw }), providers)).toThrow(
        /positive integer/
      )
    })
  })

  it('reads the record flag', () => {
    expect(resolveEvalConfig(live({ HOUSTON_EVAL_RECORD: '1' }), providers).record).toBe(true)
    expect(resolveEvalConfig(live(), providers).record).toBe(false)
  })
})
