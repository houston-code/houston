import { describe, it, expect } from 'vitest'
import Anthropic from '@anthropic-ai/sdk'
import { anthropicDefaultHeaders } from './anthropic'

/**
 * Which header carries the API key. SDK 1.x sends it as `Authorization: Bearer`, where
 * 0.x sent `X-Api-Key`. api.anthropic.com accepts either, but a gateway behind a custom
 * base URL may read only `X-Api-Key`, so Houston keeps sending the key there for gateways.
 * These drive the REAL SDK with a stub fetch and read the headers it actually sends, so
 * an SDK change to how `Authorization: null` or header merging works fails here.
 */

async function sentHeaders(apiKey: string, baseURL?: string, headers?: Record<string, string>): Promise<Headers> {
  let seen: Headers | undefined
  const client = new Anthropic({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(anthropicDefaultHeaders(apiKey, baseURL, headers)
      ? { defaultHeaders: anthropicDefaultHeaders(apiKey, baseURL, headers) }
      : {}),
    maxRetries: 0,
    fetch: async (_url, init) => {
      seen = new Headers(init?.headers as HeadersInit)
      return new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  await client.models.list({ limit: 1 })
  return seen!
}

describe('API key header', () => {
  it('sends the key as a bearer token to api.anthropic.com, the SDK default', async () => {
    const h = await sentHeaders('sk-first-party')
    expect(h.get('authorization')).toBe('Bearer sk-first-party')
    expect(h.get('x-api-key')).toBeNull()
    expect(h.get('anthropic-version')).toBe('2026-10-21')
  })

  it('treats an explicit api.anthropic.com base URL as first-party too', async () => {
    const h = await sentHeaders('sk-first-party', 'https://api.anthropic.com')
    expect(h.get('authorization')).toBe('Bearer sk-first-party')
    expect(h.get('x-api-key')).toBeNull()
  })

  it('keeps sending the key as X-Api-Key, and only there, to a gateway', async () => {
    // A gateway that reads only X-Api-Key kept working through the 1.x upgrade.
    const h = await sentHeaders('sk-gateway', 'https://llm-gateway.example.com')
    expect(h.get('x-api-key')).toBe('sk-gateway')
    expect(h.get('authorization')).toBeNull()
  })

  it("lets the user's own Authorization header for the gateway through", async () => {
    // A gateway with its own token: the user configures it as a custom header, and it
    // must not be blanked by the `Authorization: null` that suppresses the bearer key.
    const h = await sentHeaders('sk-gateway', 'https://llm-gateway.example.com', {
      Authorization: 'Bearer gateway-token'
    })
    expect(h.get('authorization')).toBe('Bearer gateway-token')
    expect(h.get('x-api-key')).toBe('sk-gateway')
  })

  it('passes other custom headers through on both paths', async () => {
    expect((await sentHeaders('k', undefined, { 'X-Team': 'a' })).get('x-team')).toBe('a')
    expect((await sentHeaders('k', 'https://gw.example.com', { 'X-Team': 'b' })).get('x-team')).toBe('b')
  })
})

describe('anthropicDefaultHeaders', () => {
  it('adds nothing for the first-party API, so the SDK default applies', () => {
    expect(anthropicDefaultHeaders('k')).toBeUndefined()
    expect(anthropicDefaultHeaders('k', 'https://api.anthropic.com/')).toBeUndefined()
    expect(anthropicDefaultHeaders('k', undefined, { 'X-Team': 'a' })).toEqual({ 'X-Team': 'a' })
  })

  it('moves the key to X-Api-Key for any other host, including an unparseable one', () => {
    expect(anthropicDefaultHeaders('k', 'https://gw.example.com')).toEqual({ 'X-Api-Key': 'k', Authorization: null })
    expect(anthropicDefaultHeaders('k', 'not a url')).toEqual({ 'X-Api-Key': 'k', Authorization: null })
  })

  it('adds no key header when there is no key', () => {
    expect(anthropicDefaultHeaders('', 'https://gw.example.com')).toBeUndefined()
  })
})
