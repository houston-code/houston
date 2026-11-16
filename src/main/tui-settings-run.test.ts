import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { exportPreferences } from '@shared/settingsPortable'
import { parseSettingsCommand } from './tui-settings-set'
import { MAX_SETTINGS_IMPORT_BYTES, runSettingsCommand, type SettingsEnv } from './tui-settings-run'
import type { Painter } from './tui'

const plain: Painter = (s) => s

function env(start: Partial<AppSettings>, answers: Array<string | null> = [], over: Partial<SettingsEnv> = {}) {
  let settings = { schemaVersion: 1, providers: [], selected: null, ...start } as AppSettings
  const out: string[] = []
  const patches: Array<Partial<AppSettings>> = []
  const prompts: string[] = []
  const secrets: string[] = []
  const keys: Array<[string, string]> = []
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tui-settings-run-')))
  const e: SettingsEnv = {
    getSettings: () => settings,
    updateSettings: (patch) => {
      patches.push(patch)
      settings = { ...settings, ...patch }
    },
    setKey: (id, key) => {
      keys.push([id, key])
      return { shadowedByEnv: null }
    },
    settingsPath: '/profile/settings.json',
    cwd: dir,
    home: dir,
    live: { reduceMotion: false, screenReader: false, notifyMode: 'auto' },
    out: (s) => out.push(s),
    readLine: async (p) => {
      prompts.push(p)
      return answers.shift() ?? null
    },
    readSecret: async (p) => {
      secrets.push(p)
      return answers.shift() ?? null
    },
    inferVerifyCommand: () => ({ command: 'npm test', source: 'package.json script test' }),
    paint: plain,
    ...over
  }
  const run = (line: string) => runSettingsCommand(parseSettingsCommand(line), e)
  return { e, run, out, text: () => out.join(''), patches, prompts, secrets, keys, dir, settings: () => settings }
}

describe('/settings set and get', () => {
  it('writes a checked patch, never the whole settings', async () => {
    const t = env({ maxIterations: 10, providers: [] })
    await t.run('set costCeilingUsd 3')
    expect(t.patches).toEqual([{ costCeilingUsd: 3 }])
    expect(t.text()).toContain('costCeilingUsd → 3')
  })

  it('writes nothing for a bad value or an unknown key', async () => {
    const t = env({})
    await t.run('set maxIterations lots')
    await t.run('set sandboxEgress {"mode":"all"}')
    expect(t.patches).toEqual([])
    expect(t.text()).toContain('maxIterations takes a whole number')
  })

  it('says what verify on stop will run when no command is set', async () => {
    const t = env({})
    await t.run('set verifyOnStop on')
    expect(t.text()).toContain('full auto runs npm test')
  })

  it('get verifyCommand shows the suggestion for this folder', async () => {
    const t = env({})
    await t.run('get verifyCommand')
    expect(t.text()).toContain('For this project: npm test')
  })

  it('is read-only where settings cannot be saved', async () => {
    const t = env({}, [], { updateSettings: undefined })
    await t.run('set maxIterations 5')
    await t.run('import x.json')
    await t.run('reset')
    expect(t.text().match(/changing settings is unavailable here/g)).toHaveLength(3)
  })
})

describe('/settings export and import', () => {
  it('exports the preferences to a new owner-only file, and never overwrites one', async () => {
    const t = env({ maxIterations: 7, additionalRoots: ['/secret/folder'] })
    await t.run('export prefs.json')
    const path = join(t.dir, 'prefs.json')
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { settings: Record<string, unknown> }
    expect(saved.settings.maxIterations).toBe(7)
    // Folders (and providers, keys, MCP servers) never travel.
    expect(saved.settings.additionalRoots).toBeUndefined()
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    await t.run('export prefs.json')
    expect(t.text()).toContain('already exists')
  })

  it('imports after a summary and a yes, flagging what widens access', async () => {
    const t = env({ maxIterations: 7 }, ['y'])
    const file = join(t.dir, 'in.json')
    writeFileSync(
      file,
      exportPreferences({
        schemaVersion: 1,
        providers: [],
        selected: null,
        maxIterations: 30,
        hooks: [{ event: 'PostToolUse', matcher: '*', command: 'curl evil' }]
      } as unknown as AppSettings)
    )
    await t.run('import in.json')
    expect(t.text()).toContain('replaces your hooks, maxIterations')
    expect(t.text()).toContain('1 hook that runs shell commands')
    expect(t.prompts.at(-1)).toContain('Import?')
    expect(t.settings().maxIterations).toBe(30)
    expect(t.text()).toContain('imported 2 preferences')
  })

  it('imports nothing without a yes', async () => {
    const t = env({ maxIterations: 7 }, ['n'])
    const file = join(t.dir, 'in.json')
    writeFileSync(file, exportPreferences({ schemaVersion: 1, providers: [], selected: null, maxIterations: 30 } as unknown as AppSettings))
    await t.run('import in.json')
    expect(t.patches).toEqual([])
    expect(t.text()).toContain('nothing imported')
  })

  it('refuses a file that is not an export, has a bad value, is missing, or is too large', async () => {
    const t = env({}, ['y', 'y', 'y'])
    writeFileSync(join(t.dir, 'junk.json'), '{"providers": []}')
    writeFileSync(
      join(t.dir, 'bad.json'),
      JSON.stringify({ format: 'houston-settings', version: 1, settings: { maxIterations: -1 } })
    )
    writeFileSync(join(t.dir, 'big.json'), 'x'.repeat(MAX_SETTINGS_IMPORT_BYTES + 1))
    await t.run('import junk.json')
    await t.run('import bad.json')
    await t.run('import missing.json')
    await t.run('import big.json')
    expect(t.patches).toEqual([])
    expect(t.text()).toContain('not a Houston settings export')
    expect(t.text()).toContain('"maxIterations" has a value Houston does not accept')
    expect(t.text()).toContain('no file at')
    expect(t.text()).toContain('too large')
  })
})

describe('/settings reset', () => {
  it('resets the preferences after a yes, keeping rules, hooks, and the approval mode', async () => {
    const t = env(
      {
        maxIterations: 7,
        approvalPolicy: 'ask',
        permissionRules: [{ tool: 'run_shell', match: 'ls', action: 'allow' }]
      },
      ['yes']
    )
    await t.run('reset')
    expect(t.settings().maxIterations).toBeUndefined()
    expect(t.settings().approvalPolicy).toBe('ask')
    expect(t.settings().permissionRules).toHaveLength(1)
    expect(Object.keys(t.patches[0])).not.toContain('permissionRules')
  })

  it('does nothing without a yes', async () => {
    const t = env({ maxIterations: 7 }, [''])
    await t.run('reset')
    expect(t.patches).toEqual([])
  })
})

describe('/settings search-key', () => {
  it("stores the key under the provider's own id, read hidden", async () => {
    const t = env({ searchProvider: 'brave' }, ['bsk-123'])
    await t.run('search-key')
    expect(t.secrets).toHaveLength(1)
    expect(t.prompts).toEqual([])
    expect(t.keys).toEqual([['web-search:brave', 'bsk-123']])
    expect(t.text()).not.toContain('bsk-123')
    // The key never lands in settings.json.
    expect(t.patches).toEqual([])
  })

  it('refuses an unknown provider, and an empty key changes nothing', async () => {
    const t = env({}, [''])
    await t.run('search-key google')
    expect(t.text()).toContain('no web search provider "google"')
    await t.run('search-key exa')
    expect(t.keys).toEqual([])
    expect(t.text()).toContain('nothing changed')
  })
})
