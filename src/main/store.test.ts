import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Migration behaviour for the settings store. `getSettings()` runs `migrate()` on the
 * raw on-disk JSON, so we drive it by writing a `settings.json` and importing the
 * module fresh (the module caches the loaded settings, so each case resets modules).
 * `electron.app.getPath` is pointed at a temp dir and `./secrets` is stubbed — these
 * tests are about the provider/model migration, not key storage.
 */

const state = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData }
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
