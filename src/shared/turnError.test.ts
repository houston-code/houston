import { describe, expect, it } from 'vitest'
import { TURN_ERROR_CAUSES, causeFromMessage, isTurnErrorCause, turnErrorHelp } from './turnError'

describe('turnErrorHelp', () => {
  it('explains every cause in plain words, with at least one next step', () => {
    for (const c of TURN_ERROR_CAUSES) {
      const h = turnErrorHelp(c, '')
      expect(h.summary).toMatch(/\.$/)
      expect(h.hint.length).toBeGreaterThan(0)
      expect(h.actions.length).toBeGreaterThan(0)
      // Customer-facing copy: no em dashes.
      expect(`${h.summary} ${h.hint}`).not.toContain('—')
    }
  })

  it('offers the provider settings for a bad key and a model switch for a missing model', () => {
    expect(turnErrorHelp('auth', 'x').actions[0]).toBe('provider-settings')
    expect(turnErrorHelp('model-not-found', 'x').actions[0]).toBe('switch-model')
    expect(turnErrorHelp('network', 'x').actions).toContain('doctor')
  })

  it('explains a credit check against the reply allowance apart from an empty account', () => {
    const msg =
      '402 This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 51285.'
    const h = turnErrorHelp('quota', msg)
    expect(h.summary).toBe("The provider account doesn't have enough credit left for this request.")
    expect(h.hint).toContain('longest reply')
    expect(h.actions).toEqual(['provider-settings', 'switch-model', 'retry'])
    expect(`${h.summary} ${h.hint}`).not.toContain('—')
    // Read from the message alone too (a failure saved without a cause).
    expect(turnErrorHelp(undefined, msg)).toBe(h)
    // An ordinary exhausted quota keeps the general wording.
    expect(turnErrorHelp('quota', 'You exceeded your current quota').summary).toContain('out of credit')
  })

  it('falls back to reading the message, then to a generic retry', () => {
    expect(turnErrorHelp(undefined, 'No API key set for OpenAI.').summary).toContain('API key')
    expect(turnErrorHelp(undefined, 'something odd')).toMatchObject({
      summary: 'The last turn failed.',
      actions: ['retry', 'doctor']
    })
  })
})

describe('causeFromMessage', () => {
  it.each([
    ['No API key set for Anthropic (Claude).', 'auth'],
    ['401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'auth'],
    ['429 You exceeded your current quota, please check your plan and billing details.', 'quota'],
    ['Your credit balance is too low to access the API.', 'quota'],
    ['402 This request requires more credits, or fewer max_tokens. You requested up to 131072 tokens, but can only afford 51285.', 'quota'],
    ['402 Insufficient credits', 'quota'],
    ['429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit', 'rate-limit'],
    ['529 Overloaded', 'provider-down'],
    ['Connection error. (getaddrinfo ENOTFOUND api.anthropic.com, ENOTFOUND)', 'network'],
    ['OpenAI doesn\'t recognize the model "gpt-x": it may be mistyped', 'model-not-found'],
    ["The conversation is too large for this model's context window, even after compacting", 'context-too-long'],
    ['The selected model "llama2" doesn\'t support tool calling, which this agent requires.', 'tools-unsupported']
  ])('%s', (message, cause) => {
    expect(causeFromMessage(message)).toBe(cause)
  })

  it('names nothing it cannot be sure of', () => {
    expect(causeFromMessage('The turn stopped on an unexpected error: x is undefined')).toBeUndefined()
    expect(causeFromMessage('Requested 550 completions')).toBeUndefined()
    expect(causeFromMessage('Read 402 files')).toBeUndefined()
  })
})

describe('isTurnErrorCause', () => {
  it('accepts only known causes', () => {
    expect(isTurnErrorCause('auth')).toBe(true)
    expect(isTurnErrorCause('nope')).toBe(false)
    expect(isTurnErrorCause(3)).toBe(false)
  })
})
