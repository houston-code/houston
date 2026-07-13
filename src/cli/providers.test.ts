import { describe, expect, it } from 'vitest'
import type { AppSettings, ProviderConfig } from '@shared/types'
import { runProvidersCommand, type ProvidersDeps } from './providers'

const provider = (over: Partial<ProviderConfig>): ProviderConfig =>
  ({ id: 'x', kind: 'openai-compatible', models: [], requiresKey: true, hasKey: false, ...over }) as ProviderConfig

function makeDeps(over: Partial<ProvidersDeps> = {}) {
  let settings = {
    providers: [
      provider({ id: 'anthropic', label: 'Anthropic', models: [{ id: 'claude' }], builtIn: true }),
      provider({ id: 'ollama', label: 'Ollama', requiresKey: false, models: [{ id: 'llama' }], builtIn: true })
    ]
  } as unknown as AppSettings
  const keys = new Map<string, string>()
  const out: string[] = []
  const err: string[] = []
  const deps: ProvidersDeps = {
    getSettings: () => settings,
    saveSettings: (s) => {
      settings = s
      return s
    },
    hasKey: (id) => keys.has(id),
    setKey: (id, key) => {
      keys.set(id, key)
      return { shadowedByEnv: null }
    },
    removeKey: (id) => keys.delete(id),
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    isMac: true,
    readStdin: async () => null,
    ...over
  }
  return { deps, out: () => out.join(''), err: () => err.join(''), settings: () => settings, keys }
}

describe('providers list', () => {
  it('lists configured providers with key status and hosts to add', async () => {
    const t = makeDeps()
    t.keys.set('anthropic', 'k')
    const code = await runProvidersCommand([], t.deps)
    expect(code).toBe(0)
    const out = t.out()
    expect(out).toContain('anthropic')
    expect(out).toContain('key set')
    expect(out).toContain('no key needed') // ollama
    expect(out).toContain('Available to add')
    expect(out).toContain('openrouter')
  })

  it('marks a required-but-missing key as NO KEY', async () => {
    const t = makeDeps()
    await runProvidersCommand(['list'], t.deps)
    expect(t.out()).toMatch(/anthropic\s+NO KEY/)
  })
})

describe('providers add', () => {
  it('adds a catalog host to settings', async () => {
    const t = makeDeps()
    const code = await runProvidersCommand(['add', 'openrouter'], t.deps)
    expect(code).toBe(0)
    expect(t.settings().providers.some((p) => p.id === 'openrouter')).toBe(true)
    expect(t.out()).toContain('set-key openrouter')
  })

  it('errors on an unknown host and lists valid ids', async () => {
    const t = makeDeps()
    const code = await runProvidersCommand(['add', 'nope'], t.deps)
    expect(code).toBe(2)
    expect(t.err()).toContain('openrouter')
    expect(t.settings().providers.some((p) => p.id === 'nope')).toBe(false)
  })

  it('is idempotent when the provider is already configured', async () => {
    const t = makeDeps()
    await runProvidersCommand(['add', 'openrouter'], t.deps)
    const before = t.settings().providers.length
    await runProvidersCommand(['add', 'openrouter'], t.deps)
    expect(t.settings().providers.length).toBe(before)
    expect(t.out()).toContain('already configured')
  })

  it('requires an id', async () => {
    const t = makeDeps()
    expect(await runProvidersCommand(['add'], t.deps)).toBe(2)
  })
})

describe('providers remove', () => {
  it('removes a non-built-in provider', async () => {
    const t = makeDeps()
    await runProvidersCommand(['add', 'openrouter'], t.deps)
    const code = await runProvidersCommand(['remove', 'openrouter'], t.deps)
    expect(code).toBe(0)
    expect(t.settings().providers.some((p) => p.id === 'openrouter')).toBe(false)
  })

  it('refuses to remove a built-in provider', async () => {
    const t = makeDeps()
    const code = await runProvidersCommand(['remove', 'anthropic'], t.deps)
    expect(code).toBe(2)
    expect(t.err()).toMatch(/built-in/i)
    expect(t.settings().providers.some((p) => p.id === 'anthropic')).toBe(true)
  })

  it('errors on an unknown provider', async () => {
    const t = makeDeps()
    expect(await runProvidersCommand(['remove', 'ghost'], t.deps)).toBe(2)
  })
})

describe('providers set-key', () => {
  it('stores a key given as an argument', async () => {
    const t = makeDeps()
    await runProvidersCommand(['add', 'openrouter'], t.deps)
    const code = await runProvidersCommand(['set-key', 'openrouter', 'or-secret'], t.deps)
    expect(code).toBe(0)
    expect(t.keys.get('openrouter')).toBe('or-secret')
    expect(t.out()).toContain('cli-credentials.json')
  })

  it('reads a key piped on stdin when none is passed', async () => {
    const t = makeDeps({ readStdin: async () => 'piped-secret\n' })
    await runProvidersCommand(['add', 'openrouter'], t.deps)
    await runProvidersCommand(['set-key', 'openrouter'], t.deps)
    expect(t.keys.get('openrouter')).toBe('piped-secret')
  })

  it('warns when an env var shadows the stored key', async () => {
    const t = makeDeps({ setKey: () => ({ shadowedByEnv: 'OPENROUTER_API_KEY' }) })
    await runProvidersCommand(['set-key', 'openrouter', 'k'], t.deps)
    expect(t.out()).toContain('OPENROUTER_API_KEY')
    expect(t.out()).toMatch(/precedence/i)
  })

  it('errors when no key is available', async () => {
    const t = makeDeps({ readStdin: async () => null })
    const code = await runProvidersCommand(['set-key', 'openrouter'], t.deps)
    expect(code).toBe(2)
    expect(t.err()).toMatch(/no key given/i)
  })
})

describe('providers remove-key', () => {
  it('removes a stored key', async () => {
    const t = makeDeps()
    t.keys.set('openrouter', 'k')
    const code = await runProvidersCommand(['remove-key', 'openrouter'], t.deps)
    expect(code).toBe(0)
    expect(t.keys.has('openrouter')).toBe(false)
  })

  it('is a friendly no-op when there is no stored key', async () => {
    const t = makeDeps()
    await runProvidersCommand(['remove-key', 'openrouter'], t.deps)
    expect(t.out()).toMatch(/nothing to remove/i)
  })
})

describe('providers routing', () => {
  it('errors on an unknown subcommand', async () => {
    const t = makeDeps()
    expect(await runProvidersCommand(['frobnicate'], t.deps)).toBe(2)
    expect(t.err()).toMatch(/unknown subcommand/i)
  })
})
