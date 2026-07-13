import { describe, expect, it } from 'vitest'
import {
  allProviderKeyEnvVars,
  genericKeyEnvVar,
  missingKeyHint,
  providerKeyEnvVars,
  providerKeyUrl
} from './provider-keys'

describe('providerKeyEnvVars', () => {
  it('returns the documented var(s) then the generic fallback for built-ins', () => {
    expect(providerKeyEnvVars('anthropic')).toEqual(['ANTHROPIC_API_KEY', 'HOUSTON_API_KEY_ANTHROPIC'])
    expect(providerKeyEnvVars('gemini')).toEqual([
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'HOUSTON_API_KEY_GEMINI'
    ])
  })

  it('covers the catalog cloud hosts', () => {
    expect(providerKeyEnvVars('openrouter')).toEqual(['OPENROUTER_API_KEY', 'HOUSTON_API_KEY_OPENROUTER'])
    expect(providerKeyEnvVars('groq')).toEqual(['GROQ_API_KEY', 'HOUSTON_API_KEY_GROQ'])
  })

  it('falls back to only the generic form for an unknown id', () => {
    expect(providerKeyEnvVars('my-custom')).toEqual(['HOUSTON_API_KEY_MY_CUSTOM'])
  })
})

describe('genericKeyEnvVar', () => {
  it('uppercases and collapses non-alphanumerics to underscores', () => {
    expect(genericKeyEnvVar('my custom.provider-2')).toBe('HOUSTON_API_KEY_MY_CUSTOM_PROVIDER_2')
  })
})

describe('allProviderKeyEnvVars', () => {
  it('lists every documented provider key var (for redaction)', () => {
    const all = allProviderKeyEnvVars()
    expect(all).toContain('ANTHROPIC_API_KEY')
    expect(all).toContain('OPENROUTER_API_KEY')
    expect(all).toContain('GOOGLE_API_KEY')
    // Only real names, no generic template.
    expect(all.every((n) => !n.includes('<'))).toBe(true)
  })
})

describe('missingKeyHint', () => {
  it('names the provider and its primary env var, not the raw provider error', () => {
    const hint = missingKeyHint('anthropic')
    expect(hint).toContain('"anthropic"')
    expect(hint).toContain('ANTHROPIC_API_KEY')
    expect(hint).not.toMatch(/x-api-key/i)
  })

  it('points at the interactive /login flow and the non-interactive CLI subcommand', () => {
    const hint = missingKeyHint('anthropic')
    expect(hint).toContain('houston -i')
    expect(hint).toContain('/login')
    expect(hint).toContain('houston providers set-key anthropic')
    // The old opaque credentials-file instruction is gone.
    expect(hint).not.toContain('cli-credentials.json')
  })

  it('uses just the generic form for an unknown provider', () => {
    expect(missingKeyHint('acme')).toContain('HOUSTON_API_KEY_ACME')
  })
})

describe('providerKeyUrl', () => {
  it('returns a sign-up URL for built-in cloud providers', () => {
    expect(providerKeyUrl('anthropic')).toMatch(/^https:\/\//)
    expect(providerKeyUrl('openai')).toMatch(/^https:\/\//)
    expect(providerKeyUrl('gemini')).toMatch(/^https:\/\//)
  })

  it('returns undefined for a custom / unknown id', () => {
    expect(providerKeyUrl('custom-abc12345')).toBeUndefined()
  })
})
