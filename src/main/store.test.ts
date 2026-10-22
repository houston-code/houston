import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig, PermissionRule } from '@shared/types'
import { REDACTED_HEADER_VALUE, mcpHeaderScope, providerHeaderScope } from '@shared/types'
import { DEFAULT_REASONING_EFFORT, SETTINGS_SCHEMA_VERSION } from '@shared/defaults'

/**
 * Migration behaviour for the settings store. `getSettings()` runs `migrate()` on the
 * raw on-disk JSON, so we drive it by writing a `settings.json` and importing the
 * module fresh (the module caches the loaded settings, so each case resets modules).
 * The userData seam is pointed at a temp dir; the injected hasKey check is stubbed
 * false and the injected header-secret store is an in-memory map — these tests are
 * about the provider/model migration and header handling, not key encryption
 * (secrets.test.ts covers the real safeStorage-backed store).
 */

const state = vi.hoisted(() => ({ userData: '' }))
// In-memory stand-in for the encrypted header store, so header round-trips are
// observable without a real Keychain.
const headerStore = vi.hoisted(() => ({ map: {} as Record<string, Record<string, string>> }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

type StoreModule = typeof import('./store')

/**
 * Fresh store module with the injected seams wired: the credential-presence check
 * (always "no key") and an in-memory header-secret store backed by `headerStore.map`.
 */
async function loadStore(): Promise<StoreModule> {
  const store = await import('./store')
  store.configureHasKey(() => false)
  store.configureHeaderSecrets({
    get: (scope) => headerStore.map[scope] ?? {},
    set: (scope, headers) => {
      headerStore.map[scope] = { ...headers }
    },
    remove: (scope) => {
      delete headerStore.map[scope]
    }
  })
  return store
}

function openaiProvider(modelIds: string[]): unknown {
  return {
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI (GPT)',
    models: modelIds.map((id) => ({ id })),
    requiresKey: true,
    hasKey: false,
    builtIn: true
  }
}

function anthropicProvider(modelIds: string[]): unknown {
  return {
    id: 'anthropic',
    kind: 'anthropic',
    label: 'Anthropic (Claude)',
    models: modelIds.map((id) => ({ id })),
    requiresKey: true,
    hasKey: false,
    builtIn: true
  }
}

function writeSettings(obj: unknown): void {
  writeFileSync(join(state.userData, 'settings.json'), JSON.stringify(obj), 'utf8')
}

async function loadOpenAIModelIds(): Promise<string[]> {
  const { getSettings } = await loadStore()
  return getSettings().providers.find((p) => p.id === 'openai')!.models.map((m) => m.id)
}

async function loadAnthropicModelIds(): Promise<string[]> {
  const { getSettings } = await loadStore()
  return getSettings().providers.find((p) => p.id === 'anthropic')!.models.map((m) => m.id)
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-store-'))
  headerStore.map = {}
  vi.resetModules()
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
})

describe('settings migration — model backfill', () => {
  it('backfills new built-in default models into a pre-v2 saved provider list', async () => {
    writeSettings({ schemaVersion: 1, providers: [openaiProvider(['gpt-4o'])] })
    const ids = await loadOpenAIModelIds()
    expect(ids[0]).toBe('gpt-4o') // user's model kept, in place
    expect(ids).toContain('gpt-6.1-sol') // new default appended
  })

  it('treats a settings file with no schemaVersion as pre-v2 and backfills', async () => {
    writeSettings({ providers: [openaiProvider(['gpt-4o'])] })
    expect(await loadOpenAIModelIds()).toContain('gpt-6.1-sol')
  })

  it('does not re-add a default model a v2 install has already deleted', async () => {
    // Migration already ran (v2); the user has since removed the old gpt-5 flagship — a
    // full backfill must not resurrect it. Later bumps scope their OpenAI adds to their
    // own new ids (which the user never deleted), leaving gpt-5 gone.
    writeSettings({ schemaVersion: 2, providers: [openaiProvider(['gpt-4o'])] })
    const ids = await loadOpenAIModelIds()
    expect(ids).not.toContain('gpt-5')
    expect(ids).toContain('gpt-6.1-sol') // the v8 scoped add still runs
  })

  it('adds the GPT-6 line on the v8 bump without pruning the 5.x models', async () => {
    writeSettings({ schemaVersion: 7, providers: [openaiProvider(['gpt-5.6-sol', 'o3'])] })
    expect(await loadOpenAIModelIds()).toEqual([
      'gpt-5.6-sol',
      'o3',
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-luna'
    ])
  })

  it('seeds the Claude 5.x lineup into a v8 Anthropic provider on the v9 bump', async () => {
    writeSettings({ schemaVersion: 8, providers: [anthropicProvider(['claude-opus-4-8'])] })
    const ids = await loadAnthropicModelIds()
    expect(ids[0]).toBe('claude-opus-4-8') // user's model kept, in place
    // Haiku 5.5 arrives too, via the later scoped v12 add.
    expect(ids).toEqual(['claude-opus-4-8', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  })

  it('scopes the v9 bump to the new ids — does not re-add a default the user deleted', async () => {
    // A v8 install that dropped Haiku gets the 5.x models, but not Haiku back.
    writeSettings({ schemaVersion: 8, providers: [anthropicProvider(['claude-opus-4-8'])] })
    expect(await loadAnthropicModelIds()).not.toContain('claude-haiku-4-5')
  })

  it('does not re-add a 5.x model a v9 install has already deleted', async () => {
    writeSettings({ schemaVersion: 9, providers: [anthropicProvider(['claude-opus-5-5'])] })
    // Fable 5.1 and Sonnet 5.5 stay deleted; only the later v12 Haiku 5.5 add is new.
    expect(await loadAnthropicModelIds()).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  })

  it('gives a pre-v2 install the full backfill without duplicating the v9 ids', async () => {
    // fromVersion 0 runs every gate: the full v2 seed and the scoped v9 add.
    writeSettings({ schemaVersion: 1, providers: [anthropicProvider(['claude-opus-4-8'])] })
    const ids = await loadAnthropicModelIds()
    expect(ids).toContain('claude-haiku-5-5') // full backfill ran
    expect(ids).toContain('claude-opus-5-5')
    expect(ids.filter((id) => id === 'claude-fable-5-1')).toHaveLength(1) // no duplicate
  })

  it('stamps the current schema version on load', async () => {
    writeSettings({ schemaVersion: 1, providers: [openaiProvider(['gpt-4o'])] })
    const { getSettings } = await loadStore()
    expect(getSettings().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('v4 strips stale hardcoded model labels from a built-in provider', async () => {
    // A pre-v4 install seeded title-case labels ("Claude Opus 4.8") that never matched
    // fetched ids; the v4 migration drops them so the display name derives from the id.
    writeSettings({
      schemaVersion: 3,
      providers: [
        {
          id: 'anthropic',
          kind: 'anthropic',
          label: 'Anthropic (Claude)',
          models: [{ id: 'claude-opus-4-8', label: 'Claude Opus 4.8' }],
          requiresKey: true,
          hasKey: false,
          builtIn: true
        }
      ]
    })
    const { getSettings } = await loadStore()
    const anthropic = getSettings().providers.find((p) => p.id === 'anthropic')!
    expect(anthropic.models.find((m) => m.id === 'claude-opus-4-8')).toEqual({ id: 'claude-opus-4-8' })
  })
})

describe('settings migration — Claude Haiku 5.5 (v12)', () => {
  it('adds Haiku 5.5 and keeps Haiku 4.5, which still serves', async () => {
    writeSettings({ schemaVersion: 11, providers: [anthropicProvider(['claude-opus-5-5', 'claude-haiku-4-5'])] })
    expect(await loadAnthropicModelIds()).toEqual(['claude-opus-5-5', 'claude-haiku-4-5', 'claude-haiku-5-5'])
  })

  it('does not re-add Haiku 5.5 a v12 install has deleted', async () => {
    writeSettings({ schemaVersion: 12, providers: [anthropicProvider(['claude-opus-5-5'])] })
    expect(await loadAnthropicModelIds()).toEqual(['claude-opus-5-5'])
  })
})

describe('settings migration — local provider names (v11)', () => {
  const local = (id: string, label: string): unknown => ({
    id,
    kind: 'openai-compatible',
    label,
    baseUrl: 'http://localhost:11434/v1',
    models: [],
    requiresKey: false,
    hasKey: false,
    builtIn: true
  })

  it('renames the old seeded local provider names on upgrade', async () => {
    writeSettings({
      schemaVersion: 10,
      providers: [local('ollama', 'Local \u2014 Ollama'), local('lmstudio', 'Local \u2014 LM Studio')]
    })
    const { getSettings } = await loadStore()
    expect(getSettings().providers.map((p) => p.label)).toEqual(['Ollama (local)', 'LM Studio (local)'])
  })

  it('keeps a local provider name the user changed', async () => {
    writeSettings({ schemaVersion: 10, providers: [local('ollama', 'Studio Mac')] })
    const { getSettings } = await loadStore()
    expect(getSettings().providers[0].label).toBe('Studio Mac')
  })
})

describe('settings migration — retired Gemini models (v6)', () => {
  function geminiProvider(modelIds: string[], defaultModel?: string): unknown {
    return {
      id: 'gemini',
      kind: 'gemini',
      label: 'Google (Gemini)',
      models: modelIds.map((id) => ({ id })),
      ...(defaultModel ? { defaultModel } : {}),
      requiresKey: true,
      hasKey: false,
      builtIn: true
    }
  }

  it('prunes the retired flash models and seeds the current 3.x line', async () => {
    // Google retired gemini-2.5-flash / gemini-2.0-flash; they 404 on every call, so an
    // upgraded install must not keep offering them.
    writeSettings({
      schemaVersion: 5,
      providers: [geminiProvider(['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'])]
    })
    const { getSettings } = await loadStore()
    const ids = getSettings()
      .providers.find((p) => p.id === 'gemini')!
      .models.map((m) => m.id)
    expect(ids).not.toContain('gemini-2.5-flash')
    expect(ids).not.toContain('gemini-2.0-flash')
    expect(ids).toContain('gemini-2.5-pro')
    expect(ids).toContain('gemini-3.8-flash') // the current line, via the v7 add
  })

  it('falls back to the built-in default when defaultModel pointed at a retired model', async () => {
    // Otherwise every new conversation would open on a model the API refuses to serve.
    writeSettings({
      schemaVersion: 5,
      providers: [geminiProvider(['gemini-2.5-pro', 'gemini-2.5-flash'], 'gemini-2.5-flash')]
    })
    const { getSettings } = await loadStore()
    const gemini = getSettings().providers.find((p) => p.id === 'gemini')!
    expect(gemini.defaultModel).toBe('gemini-3.8-flash')
  })

  it('leaves a same-named model on a custom endpoint alone', async () => {
    // A user's own proxy may still serve gemini-2.5-flash; only built-in defaults are pruned.
    writeSettings({
      schemaVersion: 5,
      providers: [
        {
          id: 'my-proxy',
          kind: 'openai-compatible',
          label: 'My proxy',
          baseUrl: 'https://proxy.example/v1',
          models: [{ id: 'gemini-2.5-flash' }],
          requiresKey: false,
          hasKey: false,
          builtIn: false
        }
      ]
    })
    const { getSettings } = await loadStore()
    const proxy = getSettings().providers.find((p) => p.id === 'my-proxy')!
    expect(proxy.models.map((m) => m.id)).toEqual(['gemini-2.5-flash'])
  })

  it('does not re-add the retired models on a later load', async () => {
    // The prune must stick: an up-to-date install reloading must not resurrect them.
    writeSettings({
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      providers: [geminiProvider(['gemini-2.5-pro'])]
    })
    const { getSettings } = await loadStore()
    const ids = getSettings()
      .providers.find((p) => p.id === 'gemini')!
      .models.map((m) => m.id)
    expect(ids).toEqual(['gemini-2.5-pro'])
  })

  it('adds the current Gemini line on the v7 bump without pruning 2.5-pro', async () => {
    // 2.5-pro is closed to NEW users only; an account that has it keeps working.
    writeSettings({ schemaVersion: 6, providers: [geminiProvider(['gemini-2.5-pro'], 'gemini-2.5-pro')] })
    const { getSettings } = await loadStore()
    const gemini = getSettings().providers.find((p) => p.id === 'gemini')!
    // 3.1-pro-preview left the seed in v13, so the v7 add now brings only the Flash tiers;
    // the later v13 add brings Gemini 4 Argon.
    expect(gemini.models.map((m) => m.id)).toEqual([
      'gemini-2.5-pro',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-4-argon'
    ])
    expect(gemini.defaultModel).toBe('gemini-2.5-pro') // the user's stored choice stands
  })

  it('adds Gemini 4 Argon on the v13 bump and keeps 3.1-pro-preview, which still serves', async () => {
    writeSettings({ schemaVersion: 12, providers: [geminiProvider(['gemini-3.1-pro-preview', 'gemini-3.8-flash'])] })
    const { getSettings } = await loadStore()
    expect(getSettings().providers.find((p) => p.id === 'gemini')!.models.map((m) => m.id)).toEqual([
      'gemini-3.1-pro-preview',
      'gemini-3.8-flash',
      'gemini-4-argon'
    ])
  })
})

describe('settings migration — reasoning default (v14)', () => {
  it('moves the old stamped off default to the new default once', async () => {
    // Every pre-v14 install wrote reasoningEffort: 'off' as the default.
    writeSettings({ schemaVersion: 13, reasoningEffort: 'off' })
    const { getSettings } = await loadStore()
    expect(getSettings().reasoningEffort).toBe(DEFAULT_REASONING_EFFORT)
    expect(DEFAULT_REASONING_EFFORT).toBe('high')
  })

  it('keeps a level other than off, which was chosen deliberately', async () => {
    writeSettings({ schemaVersion: 13, reasoningEffort: 'low' })
    const { getSettings } = await loadStore()
    expect(getSettings().reasoningEffort).toBe('low')
  })

  it('leaves off alone once the install is past v14', async () => {
    // Someone who turns reasoning off after the migration keeps it off.
    writeSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, reasoningEffort: 'off' })
    const { getSettings } = await loadStore()
    expect(getSettings().reasoningEffort).toBe('off')
  })

  it('starts a fresh install at the default', async () => {
    const { getSettings } = await loadStore()
    expect(getSettings().reasoningEffort).toBe(DEFAULT_REASONING_EFFORT)
  })
})

describe('fresh-install approval mode', () => {
  it('starts a fresh install in the configured mode', async () => {
    const store = await loadStore()
    store.configureFreshInstallApprovalPolicy(() => 'full-auto')
    expect(store.getSettings().approvalPolicy).toBe('full-auto')
  })

  it('keeps the mode an existing install saved', async () => {
    writeSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, approvalPolicy: 'ask' })
    const store = await loadStore()
    store.configureFreshInstallApprovalPolicy(() => 'full-auto')
    expect(store.getSettings().approvalPolicy).toBe('ask')
  })

  it('gives an unreadable settings file the plain default, not the fresh-install mode', async () => {
    writeFileSync(join(state.userData, 'settings.json'), '{not json', 'utf8')
    const store = await loadStore()
    store.configureFreshInstallApprovalPolicy(() => 'full-auto')
    expect(store.getSettings().approvalPolicy).toBe('ask')
  })

  it('falls back to ask when nothing configured it', async () => {
    const store = await loadStore()
    expect(store.getSettings().approvalPolicy).toBe('ask')
  })
})

describe('settings migration — window-relative compaction threshold (v5)', () => {
  it('drops the old stamped fixed default so upgraded installs get automatic sizing', async () => {
    // Pre-v5 versions wrote compactionThreshold: 100_000 into every settings.json,
    // indistinguishable from a user choice. The v5 bump removes exactly that value.
    writeSettings({
      schemaVersion: 4,
      providers: [openaiProvider(['gpt-4o'])],
      compactionThreshold: 100_000
    })
    const { getSettings } = await loadStore()
    expect(getSettings().compactionThreshold).toBeUndefined()
  })

  it('keeps any other stored value as a deliberate override', async () => {
    writeSettings({
      schemaVersion: 4,
      providers: [openaiProvider(['gpt-4o'])],
      compactionThreshold: 30_000
    })
    const { getSettings } = await loadStore()
    expect(getSettings().compactionThreshold).toBe(30_000)
  })

  it('keeps 0 (compaction disabled) across the bump', async () => {
    writeSettings({
      schemaVersion: 4,
      providers: [openaiProvider(['gpt-4o'])],
      compactionThreshold: 0
    })
    const { getSettings } = await loadStore()
    expect(getSettings().compactionThreshold).toBe(0)
  })

  it('does not touch an explicit 100k stored by a v5+ install', async () => {
    writeSettings({
      schemaVersion: 5,
      providers: [openaiProvider(['gpt-4o'])],
      compactionThreshold: 100_000
    })
    const { getSettings } = await loadStore()
    expect(getSettings().compactionThreshold).toBe(100_000)
  })

  it('seeds fresh installs with no stored threshold (automatic)', async () => {
    const { getSettings } = await loadStore()
    expect(getSettings().compactionThreshold).toBeUndefined()
  })
})

describe('selected-model reconciliation', () => {
  it('re-points a selection to the provider default when the model was removed on save', async () => {
    // Simulate the Settings flow: the user deletes the selected model from the provider
    // list and saves. `selected` still points at the removed id until we reconcile.
    const { getSettings, saveSettings } = await loadStore()
    const next = {
      ...getSettings(),
      providers: [
        {
          id: 'anthropic',
          kind: 'anthropic' as const,
          label: 'Anthropic (Claude)',
          models: [{ id: 'claude-opus-4-8' }],
          defaultModel: 'claude-opus-4-8',
          requiresKey: true,
          hasKey: false,
          builtIn: true
        }
      ],
      selected: { providerId: 'anthropic', model: 'claude-haiku-4-5' }
    }
    const saved = saveSettings(next)
    expect(saved.selected).toEqual({ providerId: 'anthropic', model: 'claude-opus-4-8' })
  })

  it('clears a selection whose provider no longer exists on save', async () => {
    const { getSettings, saveSettings } = await loadStore()
    const saved = saveSettings({
      ...getSettings(),
      selected: { providerId: 'ghost-provider', model: 'ghost-model' }
    })
    expect(saved.selected).toBeNull()
  })

  it('drops a dangling selection read from a hand-edited settings.json on load', async () => {
    writeSettings({
      schemaVersion: 9,
      providers: [anthropicProvider(['claude-opus-4-8'])],
      selected: { providerId: 'anthropic', model: 'a-model-that-was-deleted' }
    })
    const { getSettings } = await loadStore()
    // Same provider survives with another model → re-pointed rather than nulled.
    expect(getSettings().selected).toEqual({ providerId: 'anthropic', model: 'claude-opus-4-8' })
  })

  it('keeps a still-valid selection untouched on load', async () => {
    writeSettings({
      schemaVersion: 4,
      providers: [anthropicProvider(['claude-opus-4-8', 'claude-haiku-4-5'])],
      selected: { providerId: 'anthropic', model: 'claude-haiku-4-5' }
    })
    const { getSettings } = await loadStore()
    expect(getSettings().selected).toEqual({ providerId: 'anthropic', model: 'claude-haiku-4-5' })
  })
})

describe('addPermissionRule — from an in-prompt "Always allow/deny"', () => {
  const seed = (permissionRules: PermissionRule[]): void =>
    writeSettings({ schemaVersion: 2, providers: [openaiProvider(['gpt-4o'])], permissionRules })

  // A rule from an approval prompt is stamped with when and how it was added.
  const stamped = (rule: PermissionRule): PermissionRule => ({ ...rule, addedAt: expect.any(Number), source: 'prompt' })

  it('prepends a new rule, stamped as from a prompt, and persists it', async () => {
    seed([])
    const { addPermissionRule, getSettings } = await loadStore()
    const rule: PermissionRule = { action: 'allow', tool: 'web_fetch', match: 'https://x.com/*' }
    const before = Date.now()
    addPermissionRule(rule)
    expect(getSettings().permissionRules).toEqual([stamped(rule)])
    expect(getSettings().permissionRules?.[0].addedAt).toBeGreaterThanOrEqual(before)
  })

  it('prepends ahead of existing rules so the newest wins', async () => {
    const existing: PermissionRule = { action: 'ask', tool: '*', match: '**' }
    seed([existing])
    const { addPermissionRule, getSettings } = await loadStore()
    const rule: PermissionRule = { action: 'deny', tool: 'run_shell', match: 'rm -rf build' }
    addPermissionRule(rule)
    expect(getSettings().permissionRules).toEqual([stamped(rule), existing])
  })

  it('dedupes an identical rule (repeated clicks do not pile up)', async () => {
    const rule: PermissionRule = { action: 'allow', tool: 'web_fetch', match: 'https://x.com' }
    seed([rule])
    const { addPermissionRule, getSettings } = await loadStore()
    addPermissionRule({ action: 'allow', tool: 'web_fetch', match: 'https://x.com' })
    expect(getSettings().permissionRules).toEqual([rule])
  })

  it('keeps an exact rule and a glob rule for the same pattern apart, and persists `exact`', async () => {
    const glob: PermissionRule = { action: 'allow', tool: 'write_file', match: 'src' }
    seed([glob])
    const { addPermissionRule, getSettings } = await loadStore()
    const exact: PermissionRule = { action: 'allow', tool: 'write_file', match: 'src', exact: true }
    addPermissionRule(exact)
    addPermissionRule({ ...exact })
    expect(getSettings().permissionRules).toEqual([stamped(exact), glob])
    // A fresh load reads `exact` back from disk.
    vi.resetModules()
    const reloaded = await loadStore()
    expect(reloaded.getSettings().permissionRules).toEqual([stamped(exact), glob])
  })
})

describe('setModelUnavailable — a model its provider answered "not found" for', () => {
  const seed = (): void =>
    writeSettings({ schemaVersion: 2, providers: [openaiProvider(['gpt-4o', 'gpt-9'])], permissionRules: [] })
  // Migration backfills the default lineup too, so look at the two seeded models only.
  const models = (s: { providers: { id: string; models: { id: string }[] }[] }): unknown[] =>
    (s.providers.find((p) => p.id === 'openai')?.models ?? []).filter((m) => m.id === 'gpt-4o' || m.id === 'gpt-9')

  it('flags the model with the date and persists it, leaving the others alone', async () => {
    seed()
    const { setModelUnavailable, getSettings } = await loadStore()
    setModelUnavailable('openai', 'gpt-9', true, new Date('2026-10-20T12:00:00Z'))
    expect(models(getSettings())).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-9', unavailableAt: '2026-10-20' }])
    vi.resetModules()
    const reloaded = await loadStore()
    expect(models(reloaded.getSettings())).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-9', unavailableAt: '2026-10-20' }])
  })

  it('clears the flag', async () => {
    seed()
    const { setModelUnavailable, getSettings } = await loadStore()
    setModelUnavailable('openai', 'gpt-9', true)
    setModelUnavailable('openai', 'gpt-9', false)
    expect(models(getSettings())).toEqual([{ id: 'gpt-4o' }, { id: 'gpt-9' }])
  })

  it('writes nothing for a model or provider that is not configured, or a flag that already matches', async () => {
    seed()
    const store = await loadStore()
    const listener = vi.fn()
    store.onSettingsSaved(listener)
    store.setModelUnavailable('openai', 'not-listed', true)
    store.setModelUnavailable('nope', 'gpt-9', true)
    store.setModelUnavailable('openai', 'gpt-9', false)
    expect(listener).not.toHaveBeenCalled()
    store.setModelUnavailable('openai', 'gpt-9', true)
    store.setModelUnavailable('openai', 'gpt-9', true)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('recent workspaces — existence pruning', () => {
  it('rememberWorkspace fronts the path, dedupes, and keeps live entries in order', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-b-'))
    try {
      const { rememberWorkspace } = await loadStore()
      rememberWorkspace(a)
      expect(rememberWorkspace(b).recentWorkspaces).toEqual([b, a])
      // Re-remembering an existing live entry moves it to the front (deduped).
      expect(rememberWorkspace(a).recentWorkspaces).toEqual([a, b])
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('rememberWorkspace prunes a recent whose folder has since been deleted', async () => {
    const live = mkdtempSync(join(tmpdir(), 'ws-live-'))
    const gone = mkdtempSync(join(tmpdir(), 'ws-gone-'))
    try {
      const { rememberWorkspace } = await loadStore()
      rememberWorkspace(live)
      expect(rememberWorkspace(gone).recentWorkspaces).toEqual([gone, live])
      rmSync(gone, { recursive: true, force: true })
      // Touching recents again drops the now-missing folder.
      expect(rememberWorkspace(live).recentWorkspaces).toEqual([live])
    } finally {
      rmSync(live, { recursive: true, force: true })
    }
  })

  it('pruneRecentWorkspaces removes dead entries and is a no-op when all live', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-b-'))
    try {
      const { rememberWorkspace, pruneRecentWorkspaces, getSettings } = await loadStore()
      rememberWorkspace(a)
      rememberWorkspace(b)
      // All folders exist — prune changes nothing.
      expect(pruneRecentWorkspaces().recentWorkspaces).toEqual([b, a])
      rmSync(a, { recursive: true, force: true })
      // `a` is gone — prune drops it and persists the cleaned list.
      expect(pruneRecentWorkspaces().recentWorkspaces).toEqual([b])
      expect(getSettings().recentWorkspaces).toEqual([b])
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  it('onSettingsSaved notifies on every save until unsubscribed', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    try {
      const { rememberWorkspace, onSettingsSaved } = await loadStore()
      const seen: string[][] = []
      const off = onSettingsSaved((s) => seen.push(s.recentWorkspaces))
      rememberWorkspace(a)
      expect(seen).toEqual([[a]])
      off()
      rememberWorkspace(a)
      expect(seen).toHaveLength(1)
    } finally {
      rmSync(a, { recursive: true, force: true })
    }
  })
})

describe('git-init dismissal — "don\'t ask again for this folder"', () => {
  it('round-trips an opt-out: dismiss persists it and isGitInitDismissed reads it back', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-gi-'))
    try {
      const { dismissGitInit, isGitInitDismissed, getSettings } = await loadStore()
      expect(isGitInitDismissed(ws)).toBe(false)
      dismissGitInit(ws)
      expect(isGitInitDismissed(ws)).toBe(true)
      // Persisted under gitInitDismissed (realpath-normalized), so it survives reloads.
      expect(getSettings().gitInitDismissed).toContain(realpathSync(ws))
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('normalizes symlinked paths so the same folder matches however it is spelled', async () => {
    const real = mkdtempSync(join(tmpdir(), 'ws-real-'))
    const link = join(mkdtempSync(join(tmpdir(), 'ws-link-')), 'alias')
    try {
      symlinkSync(real, link)
      const { dismissGitInit, isGitInitDismissed } = await loadStore()
      // Opt out via the symlink; the real path (and vice versa) is still recognized.
      dismissGitInit(link)
      expect(isGitInitDismissed(real)).toBe(true)
      expect(isGitInitDismissed(link)).toBe(true)
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(link, { force: true })
    }
  })

  it('dedupes repeated opt-outs and ignores an empty path', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-gi-'))
    try {
      const { dismissGitInit, isGitInitDismissed } = await loadStore()
      dismissGitInit(ws)
      dismissGitInit(ws)
      expect(dismissGitInit(ws).gitInitDismissed).toEqual([realpathSync(ws)])
      expect(isGitInitDismissed('')).toBe(false)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })
})

describe('trusted folders — consent for project elevating config', () => {
  it('round-trips a trust decision bound to the elevating-config hash', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-tf-'))
    try {
      const { folderTrustFor, setFolderTrust, getSettings } = await loadStore()
      expect(folderTrustFor(ws, 'hash-1')).toBe('undecided')
      setFolderTrust(ws, 'trusted', 'hash-1')
      expect(folderTrustFor(ws, 'hash-1')).toBe('trusted')
      // The elevating config drifted (new hash): trust no longer applies.
      expect(folderTrustFor(ws, 'hash-2')).toBe('changed')
      // Re-trusting the new fingerprint replaces the record (no duplicates).
      setFolderTrust(ws, 'trusted', 'hash-2')
      expect(folderTrustFor(ws, 'hash-2')).toBe('trusted')
      expect(getSettings().trustedFolders).toHaveLength(1)
      expect(getSettings().trustedFolders![0].path).toBe(realpathSync(ws))
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('a persisted "never" refuses regardless of config drift', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'ws-tf-'))
    try {
      const { folderTrustFor, setFolderTrust } = await loadStore()
      setFolderTrust(ws, 'never', 'hash-1')
      expect(folderTrustFor(ws, 'hash-1')).toBe('untrusted')
      expect(folderTrustFor(ws, 'hash-2')).toBe('untrusted')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('normalizes symlinked paths like the other per-folder records', async () => {
    const real = mkdtempSync(join(tmpdir(), 'ws-tf-real-'))
    const link = join(mkdtempSync(join(tmpdir(), 'ws-tf-link-')), 'alias')
    try {
      symlinkSync(real, link)
      const { folderTrustFor, setFolderTrust } = await loadStore()
      setFolderTrust(link, 'trusted', 'h')
      expect(folderTrustFor(real, 'h')).toBe('trusted')
      expect(folderTrustFor(link, 'h')).toBe('trusted')
    } finally {
      rmSync(real, { recursive: true, force: true })
      rmSync(link, { force: true })
    }
  })
})

describe('settings.json file permissions', () => {
  // POSIX mode bits: Windows reports every writable file as 0o666 and protects the user
  // profile with ACLs instead, so there is no mode to assert there.
  it.skipIf(process.platform === 'win32')('writes settings.json 0o600 (owner read/write only)', async () => {
    const { updateSettings } = await loadStore()
    updateSettings({ theme: 'dark' })
    const mode = statSync(join(state.userData, 'settings.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe('custom-header secrets', () => {
  const providerWithHeaders = (headers: Record<string, string>): unknown => ({
    id: 'openai',
    kind: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://gateway/v1',
    headers,
    models: [{ id: 'gpt-5' }],
    requiresKey: true,
    hasKey: false,
    builtIn: true
  })

  const httpServer = (headers: Record<string, string>): McpServerConfig => ({
    id: 'remote',
    transport: 'http',
    command: '',
    url: 'https://x/mcp',
    headers,
    enabled: true
  })

  const readDisk = (): { providers: { id: string; headers?: Record<string, string> }[] } =>
    JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8'))

  it('moves cleartext provider header values off disk into the secret store and masks them to the renderer', async () => {
    writeSettings({
      schemaVersion: 2,
      providers: [providerWithHeaders({ Authorization: 'Bearer secret-tok', 'X-Title': 'Houston' })]
    })
    const { getSettings } = await loadStore()
    const settings = getSettings()

    // The renderer sees the header keys, but every value is the mask — never the token.
    const provider = settings.providers.find((p) => p.id === 'openai')!
    expect(provider.headers).toEqual({
      Authorization: REDACTED_HEADER_VALUE,
      'X-Title': REDACTED_HEADER_VALUE
    })
    expect(JSON.stringify(settings)).not.toContain('secret-tok')

    // Real values were moved into the (mocked) encrypted store...
    expect(headerStore.map[providerHeaderScope('openai')]).toEqual({
      Authorization: 'Bearer secret-tok',
      'X-Title': 'Houston'
    })
    // ...and stripped from settings.json on disk (keys kept, values blanked).
    const disk = readDisk()
    expect(disk.providers.find((p) => p.id === 'openai')!.headers).toEqual({
      Authorization: '',
      'X-Title': ''
    })
    expect(JSON.stringify(disk)).not.toContain('secret-tok')
  })

  it('applies the same masking + extraction to MCP server headers', async () => {
    writeSettings({
      schemaVersion: 2,
      providers: [openaiProvider(['gpt-5'])],
      mcpServers: [httpServer({ Authorization: 'Bearer mcp-tok' })]
    })
    const { getSettings } = await loadStore()
    const settings = getSettings()

    const server = settings.mcpServers!.find((s) => s.id === 'remote')!
    expect(server.headers).toEqual({ Authorization: REDACTED_HEADER_VALUE })
    expect(headerStore.map[mcpHeaderScope('remote')]).toEqual({ Authorization: 'Bearer mcp-tok' })
    expect(JSON.stringify(settings)).not.toContain('mcp-tok')
  })

  it('preserves a stored value when the renderer saves back the mask, and stores a newly entered one', async () => {
    writeSettings({
      schemaVersion: 2,
      providers: [providerWithHeaders({ Authorization: 'Bearer original' })]
    })
    const { getSettings, saveSettings } = await loadStore()

    // The renderer keeps Authorization masked (unchanged) and adds a new secret header.
    const loaded = getSettings()
    loaded.providers.find((p) => p.id === 'openai')!.headers = {
      Authorization: REDACTED_HEADER_VALUE,
      'X-Extra': 'Bearer brand-new'
    }
    saveSettings(loaded)
    expect(headerStore.map[providerHeaderScope('openai')]).toEqual({
      Authorization: 'Bearer original',
      'X-Extra': 'Bearer brand-new'
    })

    // Dropping a header on save removes its stored secret.
    const again = getSettings()
    again.providers.find((p) => p.id === 'openai')!.headers = { Authorization: REDACTED_HEADER_VALUE }
    saveSettings(again)
    expect(headerStore.map[providerHeaderScope('openai')]).toEqual({ Authorization: 'Bearer original' })
  })

  it('treats a partially-edited mask as unchanged rather than storing bogus bullets', async () => {
    writeSettings({
      schemaVersion: 2,
      providers: [providerWithHeaders({ Authorization: 'Bearer real' })]
    })
    const { getSettings, saveSettings } = await loadStore()
    const loaded = getSettings()
    // Simulate the user nudging the shown mask (fewer bullets) but not really editing it.
    loaded.providers.find((p) => p.id === 'openai')!.headers = { Authorization: '••••' }
    saveSettings(loaded)
    expect(headerStore.map[providerHeaderScope('openai')]).toEqual({ Authorization: 'Bearer real' })
  })

  it('does not churn the secret store on an unrelated save (mask round-trips as unchanged)', async () => {
    writeSettings({
      schemaVersion: 2,
      providers: [providerWithHeaders({ Authorization: 'Bearer keep-me' })]
    })
    const { getSettings, updateSettings } = await loadStore()
    getSettings() // migrate
    updateSettings({ theme: 'dark' }) // an unrelated change that round-trips masked headers
    expect(headerStore.map[providerHeaderScope('openai')]).toEqual({ Authorization: 'Bearer keep-me' })
    // Disk still carries no cleartext value.
    expect(JSON.stringify(readDisk())).not.toContain('keep-me')
  })
})

/** The desktop app records its version on every launch; its presence = it has run here. */
function markDesktopHasRun(): void {
  writeFileSync(join(state.userData, 'update-state.json'), JSON.stringify({ lastSeenVersion: '0.5.0' }))
}

describe('settings migration — onboarding (v10)', () => {
  it('marks every tip seen for an existing desktop install, so nothing appears on its own', async () => {
    markDesktopHasRun()
    writeSettings({ schemaVersion: 9, providers: [openaiProvider(['gpt-5.5'])] })
    const { getSettings } = await loadStore()
    expect(getSettings().onboarding).toEqual({
      seenTips: ['approval', 'worktree', 'context', 'steer', 'changes', 'revert']
    })
  })

  it('treats a legacy file with no schemaVersion as an existing desktop install too', async () => {
    markDesktopHasRun()
    writeSettings({ providers: [openaiProvider(['gpt-5.5'])] })
    const { getSettings } = await loadStore()
    expect(getSettings().onboarding?.seenTips).toHaveLength(6)
  })

  it('treats a terminal-only profile as new to the desktop app (tips stay unseen)', async () => {
    writeSettings({ schemaVersion: 9, providers: [openaiProvider(['gpt-5.5'])] })
    const { getSettings } = await loadStore()
    expect(getSettings().onboarding).toEqual({})
  })

  it('saves the upgrade at once, so a later launch keeps the same decision', async () => {
    // Terminal-only profile upgraded on the desktop app's first launch...
    writeSettings({ schemaVersion: 9, providers: [openaiProvider(['gpt-5.5'])] })
    await loadStore().then((s) => s.getSettings())
    const onDisk = JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8'))
    expect(onDisk.schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
    expect(onDisk.onboarding).toEqual({})
    // ...which then records its version. The next launch must not reclassify the user.
    markDesktopHasRun()
    vi.resetModules()
    const reloaded = await loadStore()
    expect(reloaded.getSettings().onboarding).toEqual({})
  })

  it('does not rewrite a file that is already current', async () => {
    writeSettings({ schemaVersion: SETTINGS_SCHEMA_VERSION, providers: [openaiProvider(['gpt-5.5'])] })
    const before = statSync(join(state.userData, 'settings.json')).mtimeMs
    await loadStore().then((s) => s.getSettings())
    expect(statSync(join(state.userData, 'settings.json')).mtimeMs).toBe(before)
  })

  it('leaves a fresh install (no settings file) without onboarding state', async () => {
    const { getSettings } = await loadStore()
    expect(getSettings().onboarding).toBeUndefined()
  })

  it('keeps onboarding progress already recorded at v10', async () => {
    markDesktopHasRun()
    writeSettings({
      schemaVersion: 10,
      providers: [openaiProvider(['gpt-5.5'])],
      onboarding: { checklistDone: true, seenTips: ['approval'] }
    })
    const { getSettings } = await loadStore()
    expect(getSettings().onboarding).toEqual({ checklistDone: true, seenTips: ['approval'] })
  })

  it('round-trips onboarding progress through a save', async () => {
    const { getSettings, saveSettings } = await loadStore()
    saveSettings({ ...getSettings(), onboarding: { checklistDone: true, seenTips: ['approval'] } })
    vi.resetModules()
    const reloaded = await loadStore()
    expect(reloaded.getSettings().onboarding).toEqual({ checklistDone: true, seenTips: ['approval'] })
  })
})

describe('settings written by a newer Houston (after a downgrade)', () => {
  const NEWER = 99

  it('runs no migration steps and keeps the higher version in memory', async () => {
    // Every step is gated on fromVersion < N, so a newer file is taken as already migrated:
    // the scoped backfills must not re-add models the user deleted on the newer build.
    writeSettings({ schemaVersion: NEWER, providers: [anthropicProvider(['claude-opus-4-8'])] })
    const { getSettings } = await loadStore()
    const s = getSettings()
    expect(s.schemaVersion).toBe(NEWER)
    expect(s.providers.find((p) => p.id === 'anthropic')!.models.map((m) => m.id)).toEqual(['claude-opus-4-8'])
  })

  it('never writes a lower version, and keeps settings this build does not know', async () => {
    writeSettings({
      schemaVersion: NEWER,
      providers: [anthropicProvider(['claude-opus-4-8'])],
      settingFromTheFuture: { enabled: true }
    })
    const { getSettings, saveSettings } = await loadStore()
    saveSettings({ ...getSettings(), approvalPolicy: 'auto-edit' })
    const onDisk = JSON.parse(readFileSync(join(state.userData, 'settings.json'), 'utf8'))
    expect(onDisk.schemaVersion).toBe(NEWER)
    expect(onDisk.approvalPolicy).toBe('auto-edit')
    expect(onDisk.settingFromTheFuture).toEqual({ enabled: true })
  })

  it('does not rewrite a newer file just because it was read', async () => {
    writeSettings({ schemaVersion: NEWER, providers: [anthropicProvider(['claude-opus-4-8'])] })
    const before = readFileSync(join(state.userData, 'settings.json'), 'utf8')
    const { getSettings } = await loadStore()
    getSettings()
    expect(readFileSync(join(state.userData, 'settings.json'), 'utf8')).toBe(before)
  })
})
