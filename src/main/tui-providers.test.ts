import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AppSettings, ModelOption, ProviderConfig } from '@shared/types'
import { REDACTED_HEADER_VALUE } from '@shared/types'
import { makePainter, parseSlashCommand } from './tui'
import {
  editableFields,
  findProvider,
  parseLoginArgs,
  refreshProviderModels,
  runLoginOp,
  type ProviderCommandDeps
} from './tui-providers'

const paint = makePainter(false)

const router = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'custom-1',
  kind: 'openai-compatible',
  label: 'My Router',
  baseUrl: 'https://router.internal/v1',
  requiresKey: false,
  hasKey: false,
  builtIn: false,
  models: [{ id: 'm1', label: 'Model One' }],
  ...over
})

const anthropic: ProviderConfig = {
  id: 'anthropic',
  kind: 'anthropic',
  label: 'Anthropic',
  builtIn: true,
  requiresKey: true,
  hasKey: true,
  models: [{ id: 'claude-a' }]
}

function harness(providers: ProviderConfig[], answers: Array<string | null> = [], over: Partial<ProviderCommandDeps> = {}) {
  const settings = { providers } as AppSettings
  const out: string[] = []
  const lines = [...answers]
  const secrets: string[] = []
  const prompts: string[] = []
  const deps: ProviderCommandDeps = {
    getSettings: () => settings,
    updateSettings: vi.fn((patch: Partial<AppSettings>) => Object.assign(settings, patch)),
    removeKey: vi.fn(() => true),
    readLine: vi.fn(async (p: string) => {
      prompts.push(p)
      return lines.length ? (lines.shift() as string | null) : null
    }),
    readSecret: vi.fn(async () => (secrets.length ? (secrets.shift() as string) : null)),
    out: (t) => out.push(t),
    ...over
  }
  return { settings, deps, out, secrets, prompts, text: () => out.join('') }
}

afterEach(() => vi.unstubAllEnvs())

describe('parseLoginArgs', () => {
  it('reads each verb and its provider', () => {
    expect(parseLoginArgs('')).toEqual({ op: 'menu' })
    expect(parseLoginArgs('edit openrouter')).toEqual({ op: 'edit', provider: 'openrouter' })
    expect(parseLoginArgs('rm groq')).toEqual({ op: 'remove', provider: 'groq' })
    expect(parseLoginArgs('Remove groq')).toEqual({ op: 'remove', provider: 'groq' })
    expect(parseLoginArgs('forget-key openai')).toEqual({ op: 'forget-key', provider: 'openai' })
    expect(parseLoginArgs('remove-key openai')).toEqual({ op: 'forget-key', provider: 'openai' })
  })
  it('takes a label with spaces as the provider', () => {
    expect(parseLoginArgs('edit My Router')).toEqual({ op: 'edit', provider: 'My Router' })
  })
  it('falls back to usage for a missing provider or an unknown verb', () => {
    expect(parseLoginArgs('edit')).toEqual({ op: 'usage' })
    expect(parseLoginArgs('frobnicate x')).toEqual({ op: 'usage' })
  })
  it('routes through the slash parser for /login and /providers', () => {
    const s = { providers: [] } as unknown as AppSettings
    expect(parseSlashCommand('/login', s)).toEqual({ kind: 'login' })
    expect(parseSlashCommand('/providers remove x', s)).toEqual({ kind: 'login-op', op: { op: 'remove', provider: 'x' } })
    expect(parseSlashCommand('/model refresh', s)).toEqual({ kind: 'model-refresh' })
    expect(parseSlashCommand('/model refresh openai', s)).toEqual({ kind: 'model-refresh', provider: 'openai' })
  })
})

describe('findProvider', () => {
  it('matches the id exactly first, then id or label ignoring case', () => {
    const s = { providers: [router(), anthropic] } as AppSettings
    expect(findProvider(s, 'custom-1')?.id).toBe('custom-1')
    expect(findProvider(s, 'my router')?.id).toBe('custom-1')
    expect(findProvider(s, 'ANTHROPIC')?.id).toBe('anthropic')
    expect(findProvider(s, 'nope')).toBeUndefined()
  })
})

describe('/login remove', () => {
  it('removes an added provider after a yes, and offers to forget its key', async () => {
    const h = harness([router({ hasKey: true }), anthropic], ['y', 'y'])
    await runLoginOp({ op: 'remove', provider: 'custom-1' }, h.deps, paint)
    expect(h.settings.providers.map((p) => p.id)).toEqual(['anthropic'])
    expect(h.deps.removeKey).toHaveBeenCalledWith('custom-1')
    expect(h.text()).toContain('removed My Router')
  })
  it('keeps the key when the user says no to forgetting it', async () => {
    const h = harness([router({ hasKey: true })], ['y', 'n'])
    await runLoginOp({ op: 'remove', provider: 'custom-1' }, h.deps, paint)
    expect(h.settings.providers).toEqual([])
    expect(h.deps.removeKey).not.toHaveBeenCalled()
    expect(h.text()).toContain('/login forget-key custom-1')
  })
  it('changes nothing without a yes', async () => {
    const h = harness([router()], [''])
    await runLoginOp({ op: 'remove', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.updateSettings).not.toHaveBeenCalled()
    expect(h.text()).toContain('nothing changed')
  })
  it('refuses a built-in provider and the one this chat runs on', async () => {
    const h = harness([router(), anthropic], ['y'], { activeProviderId: 'custom-1' })
    await runLoginOp({ op: 'remove', provider: 'anthropic' }, h.deps, paint)
    await runLoginOp({ op: 'remove', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.updateSettings).not.toHaveBeenCalled()
    expect(h.text()).toContain("built in and can't be removed")
    expect(h.text()).toContain('this chat runs on My Router')
  })
  it('names the configured ids for an unknown provider', async () => {
    const h = harness([router(), anthropic])
    await runLoginOp({ op: 'remove', provider: 'ghost' }, h.deps, paint)
    expect(h.text()).toContain('Configured: custom-1, anthropic')
  })
})

describe('/login forget-key', () => {
  it('forgets the stored key after a yes', async () => {
    const h = harness([anthropic], ['yes'])
    await runLoginOp({ op: 'forget-key', provider: 'anthropic' }, h.deps, paint)
    expect(h.deps.removeKey).toHaveBeenCalledWith('anthropic')
    expect(h.text()).toContain('forgot the stored key for Anthropic')
  })
  it('says when the environment still supplies a key', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-env')
    const h = harness([anthropic], ['y'])
    await runLoginOp({ op: 'forget-key', provider: 'anthropic' }, h.deps, paint)
    expect(h.text()).toContain('ANTHROPIC_API_KEY is still set')
    expect(h.text()).not.toContain('sk-env')
  })
  it('does nothing without a yes, or without a key store', async () => {
    const h = harness([anthropic], ['n'])
    await runLoginOp({ op: 'forget-key', provider: 'anthropic' }, h.deps, paint)
    expect(h.deps.removeKey).not.toHaveBeenCalled()
    const none = harness([anthropic], ['y'], { removeKey: undefined })
    await runLoginOp({ op: 'forget-key', provider: 'anthropic' }, none.deps, paint)
    expect(none.text()).toContain('unavailable here')
  })
})

describe('/login edit', () => {
  it('lists base URL for a custom endpoint and the setup fields per kind', () => {
    expect(editableFields(router()).map((f) => f.key)).toEqual(['baseUrl'])
    expect(editableFields({ ...anthropic, kind: 'vertex', id: 'vertex' }).map((f) => f.key)).toEqual(['region', 'projectId'])
    expect(editableFields({ ...anthropic, kind: 'azure-openai', id: 'az' }).map((f) => f.key)).toEqual(['endpoint', 'apiVersion'])
  })

  it('keeps a value on Enter and saves a new base URL', async () => {
    const h = harness([router()], ['https://new.internal/v1', ''])
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.settings.providers[0].baseUrl).toBe('https://new.internal/v1')
    expect(h.settings.providers[0].models).toEqual([{ id: 'm1', label: 'Model One' }])
    expect(h.text()).toContain('Base URL → https://new.internal/v1')
  })

  it('refuses a base URL that is not http(s), and saves nothing when nothing changed', async () => {
    const h = harness([router()], ['ftp://x', ''])
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.updateSettings).not.toHaveBeenCalled()
    expect(h.text()).toContain('must start with http:// or https://')
  })

  it('reads a header value hidden, saves it, and never prints it', async () => {
    const h = harness([router()], ['', 'X-Gateway-Token', ''])
    h.secrets.push('sekrit-value-123')
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.readSecret).toHaveBeenCalledTimes(1)
    expect(h.settings.providers[0].headers).toEqual({ 'X-Gateway-Token': 'sekrit-value-123' })
    expect(h.text()).toContain('header X-Gateway-Token added')
    expect(h.text()).not.toContain('sekrit-value-123')
    expect(h.prompts.join('')).not.toContain('sekrit-value-123')
  })

  it('keeps a stored header as its mask (unchanged) and removes one by -Name', async () => {
    const p = router({ headers: { 'X-Keep': REDACTED_HEADER_VALUE, 'X-Drop': REDACTED_HEADER_VALUE } })
    const h = harness([p], ['', '-x-drop', ''])
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.settings.providers[0].headers).toEqual({ 'X-Keep': REDACTED_HEADER_VALUE })
    expect(h.text()).toContain('header X-Drop removed')
  })

  it('never reads a header value with an echoing prompt', async () => {
    const h = harness([router()], ['', 'X-Token', ''], { readSecret: undefined })
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.readLine).toHaveBeenCalledTimes(2)
    expect(h.deps.updateSettings).not.toHaveBeenCalled()
    expect(h.text()).toContain("can't read a value without showing it")
  })

  it('points the standalone CLI at cli-headers.json instead of asking for values', async () => {
    const h = harness([router()], [''], { canStoreHeaderSecrets: false })
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.readSecret).not.toHaveBeenCalled()
    expect(h.text()).toContain('"provider:custom-1"')
  })

  it('cancels with nothing saved on Ctrl-D, even after a changed field', async () => {
    const h = harness([router()], ['https://new.internal/v1', null])
    await runLoginOp({ op: 'edit', provider: 'custom-1' }, h.deps, paint)
    expect(h.deps.updateSettings).not.toHaveBeenCalled()
    expect(h.text()).toContain('cancelled')
  })

  it('will not clear a required field, but clears an optional one with -', async () => {
    const vertex: ProviderConfig = { ...anthropic, id: 'vertex', kind: 'vertex', label: 'Vertex', region: 'us-east5', projectId: 'p1' }
    const h = harness([vertex], ['-', '-'])
    await runLoginOp({ op: 'edit', provider: 'vertex' }, h.deps, paint)
    expect(h.settings.providers[0].region).toBe('us-east5')
    expect(h.settings.providers[0].projectId).toBeUndefined()
    expect(h.text()).toContain('Vertex region is required')
  })
})

describe('/model refresh', () => {
  const fetched: ModelOption[] = [{ id: 'm1' }, { id: 'm2' }]
  it("adopts the listing, keeping a curated label, and says what changed", async () => {
    const h = harness([router({ models: [{ id: 'm1', label: 'Model One' }, { id: 'old' }] })], [], {
      fetchModels: vi.fn(async () => fetched),
      activeProviderId: 'custom-1',
      activeModel: 'old'
    })
    await refreshProviderModels(undefined, h.deps, paint)
    expect(h.settings.providers[0].models).toEqual([{ id: 'm1', label: 'Model One' }, { id: 'm2', label: undefined }])
    expect(h.text()).toContain('2 models; 1 new: m2; 1 no longer listed: old')
    expect(h.text()).toContain("this chat's model old is no longer listed")
  })
  it('keeps the list when the provider lists nothing or fails', async () => {
    const empty = harness([router()], [], { fetchModels: vi.fn(async () => []) })
    await refreshProviderModels('custom-1', empty.deps, paint)
    expect(empty.deps.updateSettings).not.toHaveBeenCalled()
    expect(empty.text()).toContain('kept the current list')
    const failing = harness([router()], [], { fetchModels: vi.fn(async () => Promise.reject(new Error('timed out'))) })
    await refreshProviderModels('custom-1', failing.deps, paint)
    expect(failing.deps.updateSettings).not.toHaveBeenCalled()
    expect(failing.text()).toContain('could not fetch models from My Router: timed out')
  })
  it('asks for a key first when a keyed provider has none', async () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    const openai: ProviderConfig = { ...anthropic, id: 'openai', kind: 'openai', label: 'OpenAI', hasKey: false }
    const fetchModels = vi.fn(async () => fetched)
    const h = harness([openai], [], { fetchModels })
    await refreshProviderModels('openai', h.deps, paint)
    expect(fetchModels).not.toHaveBeenCalled()
    expect(h.text()).toContain('Set one with /login first')
  })
})
