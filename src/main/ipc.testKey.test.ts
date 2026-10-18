import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'

/**
 * testProviderKey: checks a pasted API key with a live model listing WITHOUT storing
 * it, so a typo can't replace a working key. The provider lookup and the listing are
 * mocked; the point is the validation, the key override, and the error scrub.
 */

const h = vi.hoisted(() => ({
  providers: new Map<string, unknown>(),
  listModels: vi.fn<(config: unknown, key?: string) => Promise<Array<{ id: string }>>>(),
  setKey: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {} },
  app: { getVersion: () => '0.0.0-test', getPath: () => '/tmp', getName: () => 'Houston', on: () => {} },
  dialog: {},
  clipboard: {},
  nativeImage: {},
  shell: {},
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null }
}))

vi.mock('./providers', async (orig) => ({
  ...(await orig<typeof import('./providers')>()),
  listModels: h.listModels
}))

vi.mock('./store', async (orig) => ({
  ...(await orig<typeof import('./store')>()),
  getProvider: (id: string) => h.providers.get(id)
}))

vi.mock('./secrets', async (orig) => ({
  ...(await orig<typeof import('./secrets')>()),
  setKey: h.setKey
}))

const { testProviderKey } = await import('./ipc')

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    models: [],
    requiresKey: true,
    hasKey: true,
    builtIn: true,
    ...over
  }
}

beforeEach(() => {
  h.providers.clear()
  h.providers.set('anthropic', provider())
  h.providers.set('ollama', provider({ id: 'ollama', kind: 'openai-compatible', label: 'Local Ollama', requiresKey: false }))
  h.listModels.mockReset()
  h.setKey.mockReset()
})

describe('testProviderKey', () => {
  it('lists with the candidate key (trimmed) and never stores it', async () => {
    h.listModels.mockResolvedValue([{ id: 'a' }, { id: 'b' }])
    await expect(testProviderKey('anthropic', '  sk-new  ')).resolves.toBe(2)
    expect(h.listModels).toHaveBeenCalledWith(h.providers.get('anthropic'), 'sk-new')
    expect(h.setKey).not.toHaveBeenCalled()
  })

  it('rejects with the provider message, with the key scrubbed out', async () => {
    h.listModels.mockRejectedValue(new Error('401: key sk-bad is invalid (sk-bad)'))
    await expect(testProviderKey('anthropic', 'sk-bad')).rejects.toThrow('401: key [key] is invalid ([key])')
  })

  it('refuses non-string, empty, and oversized input before any network call', async () => {
    await expect(testProviderKey(42, 'k')).rejects.toThrow('Invalid provider or key.')
    await expect(testProviderKey('anthropic', { k: 1 })).rejects.toThrow('Invalid provider or key.')
    await expect(testProviderKey('anthropic', '   ')).rejects.toThrow('Invalid key.')
    await expect(testProviderKey('anthropic', 'x'.repeat(4097))).rejects.toThrow('Invalid key.')
    expect(h.listModels).not.toHaveBeenCalled()
  })

  it('refuses an unknown provider and a keyless local host', async () => {
    await expect(testProviderKey('nope', 'k')).rejects.toThrow('Unknown provider: nope')
    await expect(testProviderKey('ollama', 'k')).rejects.toThrow("doesn't use an API key")
    expect(h.listModels).not.toHaveBeenCalled()
  })
})
