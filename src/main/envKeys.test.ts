import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setUserDataDir } from './userData'
import { dismissEnvKeyOffers, dismissedEnvKeyOffers, envKeyOffers, envKeyValue } from './envKeys'

const providers = [
  { id: 'anthropic', label: 'Anthropic (Claude)', requiresKey: true },
  { id: 'openai', label: 'OpenAI (GPT)', requiresKey: true },
  { id: 'gemini', label: 'Google (Gemini)', requiresKey: true },
  { id: 'ollama', label: 'Local (Ollama)', requiresKey: false }
]

describe('envKeyValue', () => {
  it('reads the provider variable, trimmed', () => {
    expect(envKeyValue({ OPENAI_API_KEY: '  sk-proj-abcdefgh1234\n' }, 'openai')).toBe('sk-proj-abcdefgh1234')
  })

  it('ignores values that do not look like a key', () => {
    expect(envKeyValue({ OPENAI_API_KEY: 'short' }, 'openai')).toBeNull()
    expect(envKeyValue({ OPENAI_API_KEY: 'sk-abc defgh1234' }, 'openai')).toBeNull()
    expect(envKeyValue({ OPENAI_API_KEY: 'sk-abc\u0007defgh1234' }, 'openai')).toBeNull()
    expect(envKeyValue({ OPENAI_API_KEY: 'x'.repeat(5000) }, 'openai')).toBeNull()
    expect(envKeyValue({}, 'openai')).toBeNull()
  })

  it('reads only the three offered variables', () => {
    expect(envKeyValue({ GOOGLE_API_KEY: 'AIzaSyabcdefgh' }, 'gemini')).toBeNull()
    expect(envKeyValue({ OPENROUTER_API_KEY: 'sk-or-abcdefgh' }, 'openrouter')).toBeNull()
  })
})

describe('envKeyOffers', () => {
  const env = {
    ANTHROPIC_API_KEY: 'sk-ant-0123456789wxyz',
    OPENAI_API_KEY: 'sk-proj-0123456789abcd',
    GEMINI_API_KEY: 'AIza0123456789efgh'
  }

  it('offers each provider with a key in the environment and none stored', () => {
    const offers = envKeyOffers(env, { providers, hasKey: (id) => id === 'openai', dismissed: [] })
    expect(offers).toEqual([
      { providerId: 'anthropic', providerLabel: 'Anthropic (Claude)', envVar: 'ANTHROPIC_API_KEY', last4: 'wxyz' },
      { providerId: 'gemini', providerLabel: 'Google (Gemini)', envVar: 'GEMINI_API_KEY', last4: 'efgh' }
    ])
    for (const value of Object.values(env)) expect(JSON.stringify(offers)).not.toContain(value)
  })

  it('leaves out dismissed providers unless asked to include them', () => {
    const deps = { providers, hasKey: () => false, dismissed: ['anthropic'] }
    expect(envKeyOffers(env, deps).map((o) => o.providerId)).toEqual(['openai', 'gemini'])
    expect(envKeyOffers(env, deps, true).map((o) => o.providerId)).toEqual(['anthropic', 'openai', 'gemini'])
  })

  it('offers nothing for a provider the settings no longer list', () => {
    expect(envKeyOffers(env, { providers: [], hasKey: () => false, dismissed: [] })).toEqual([])
  })
})

describe('dismissed offers', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'houston-envkeys-'))
    setUserDataDir(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records Not now in its own owner-only file, keeping known providers only', () => {
    expect(dismissedEnvKeyOffers()).toEqual([])
    dismissEnvKeyOffers(['openai', 'nope', 3])
    dismissEnvKeyOffers(['openai', 'gemini'])
    expect(dismissedEnvKeyOffers()).toEqual(['openai', 'gemini'])
    const file = join(dir, 'env-key-offers.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ dismissed: ['openai', 'gemini'] })
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reads an unreadable file as nothing dismissed', () => {
    writeFileSync(join(dir, 'env-key-offers.json'), '{not json')
    expect(dismissedEnvKeyOffers()).toEqual([])
  })
})
