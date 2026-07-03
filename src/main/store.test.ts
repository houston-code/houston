import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PermissionRule } from '@shared/types'

/**
 * Migration behaviour for the settings store. `getSettings()` runs `migrate()` on the
 * raw on-disk JSON, so we drive it by writing a `settings.json` and importing the
 * module fresh (the module caches the loaded settings, so each case resets modules).
 * `electron.app.getPath` is pointed at a temp dir and `./secrets` is stubbed — these
 * tests are about the provider/model migration, not key storage.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('./userData', () => ({
  getUserDataDir: () => state.userData
}))

vi.mock('./secrets', () => ({
  hasKey: () => false
}))

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

function writeSettings(obj: unknown): void {
  writeFileSync(join(state.userData, 'settings.json'), JSON.stringify(obj), 'utf8')
}

async function loadOpenAIModelIds(): Promise<string[]> {
  const { getSettings } = await import('./store')
  return getSettings().providers.find((p) => p.id === 'openai')!.models.map((m) => m.id)
}

beforeEach(() => {
  state.userData = mkdtempSync(join(tmpdir(), 'houston-store-'))
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
    expect(ids).toContain('gpt-5') // new default appended
  })

  it('treats a settings file with no schemaVersion as pre-v2 and backfills', async () => {
    writeSettings({ providers: [openaiProvider(['gpt-4o'])] })
    expect(await loadOpenAIModelIds()).toContain('gpt-5')
  })

  it('does not re-add a default model a v2 install has already deleted', async () => {
    // Migration already ran (v2); the user has since removed gpt-5 — it must stay gone.
    writeSettings({ schemaVersion: 2, providers: [openaiProvider(['gpt-4o'])] })
    expect(await loadOpenAIModelIds()).not.toContain('gpt-5')
  })

  it('stamps the current schema version on load', async () => {
    writeSettings({ schemaVersion: 1, providers: [openaiProvider(['gpt-4o'])] })
    const { getSettings } = await import('./store')
    expect(getSettings().schemaVersion).toBe(2)
  })
})

describe('addPermissionRule — from an in-prompt "Always allow/deny"', () => {
  const seed = (permissionRules: PermissionRule[]): void =>
    writeSettings({ schemaVersion: 2, providers: [openaiProvider(['gpt-4o'])], permissionRules })

  it('prepends a new rule and persists it', async () => {
    seed([])
    const { addPermissionRule, getSettings } = await import('./store')
    const rule: PermissionRule = { action: 'allow', tool: 'web_fetch', match: 'https://x.com/*' }
    addPermissionRule(rule)
    expect(getSettings().permissionRules).toEqual([rule])
  })

  it('prepends ahead of existing rules so the newest wins', async () => {
    const existing: PermissionRule = { action: 'ask', tool: '*', match: '**' }
    seed([existing])
    const { addPermissionRule, getSettings } = await import('./store')
    const rule: PermissionRule = { action: 'deny', tool: 'run_shell', match: 'rm -rf build' }
    addPermissionRule(rule)
    expect(getSettings().permissionRules).toEqual([rule, existing])
  })

  it('dedupes an identical rule (repeated clicks do not pile up)', async () => {
    const rule: PermissionRule = { action: 'allow', tool: 'web_fetch', match: 'https://x.com' }
    seed([rule])
    const { addPermissionRule, getSettings } = await import('./store')
    addPermissionRule({ action: 'allow', tool: 'web_fetch', match: 'https://x.com' })
    expect(getSettings().permissionRules).toEqual([rule])
  })
})

describe('recent workspaces — existence pruning', () => {
  it('rememberWorkspace fronts the path, dedupes, and keeps live entries in order', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ws-a-'))
    const b = mkdtempSync(join(tmpdir(), 'ws-b-'))
    try {
      const { rememberWorkspace } = await import('./store')
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
      const { rememberWorkspace } = await import('./store')
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
      const { rememberWorkspace, pruneRecentWorkspaces, getSettings } = await import('./store')
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
})
