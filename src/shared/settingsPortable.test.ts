import { describe, expect, it } from 'vitest'
import type { AppSettings } from './types'
import {
  exportPreferences,
  isModified,
  parsePreferencesImport,
  PREFERENCE_KEYS,
  resetPreferences,
  RESETTABLE_PREFERENCES
} from './settingsPortable'
import { defaultSettings } from './defaults'

const base = (over: Partial<AppSettings> = {}): AppSettings => ({ ...defaultSettings(), ...over })

describe('isModified', () => {
  it('reads an unset setting, or one equal to its default, as unmodified', () => {
    expect(isModified(base(), ['formatOnSave', 'theme', 'stallDetection'])).toBe(false)
    expect(isModified(base({ formatOnSave: false, theme: 'system' }), ['formatOnSave', 'theme'])).toBe(false)
  })

  it('reads a value that differs from the default as modified', () => {
    expect(isModified(base({ theme: 'dark' }), ['theme'])).toBe(true)
    expect(isModified(base({ webReads: 'allow' }), ['webReads'])).toBe(true)
    expect(isModified(base({ webReads: 'ask' }), ['webReads'])).toBe(false)
    expect(isModified(base({ compactionThreshold: 0 }), ['compactionThreshold'])).toBe(true)
    expect(isModified(base({ keybindings: { 'open-settings': null } }), ['keybindings'])).toBe(true)
  })
})

describe('resetPreferences', () => {
  it('restores defaults by removing the settings', () => {
    const next = resetPreferences(base({ theme: 'dark', maxIterations: 7 }), ['theme', 'maxIterations'])
    expect(next).not.toHaveProperty('theme')
    expect(next).not.toHaveProperty('maxIterations')
  })

  it('never marks or resets the approval mode, whose default depends on the machine', () => {
    // A fresh install starts in full auto where the sandbox works and in ask elsewhere.
    expect(RESETTABLE_PREFERENCES).not.toContain('approvalPolicy')
    const fullAuto = base({ approvalPolicy: 'full-auto' })
    expect(resetPreferences(fullAuto, RESETTABLE_PREFERENCES).approvalPolicy).toBe('full-auto')
    // It still moves with an export.
    expect(PREFERENCE_KEYS).toContain('approvalPolicy')
    expect(parsePreferencesImport(exportPreferences(fullAuto))).toMatchObject({ ok: true, settings: { approvalPolicy: 'full-auto' } })
  })

  it('never resets rules, hooks, or language servers when resetting everything', () => {
    expect(RESETTABLE_PREFERENCES).not.toContain('permissionRules')
    expect(RESETTABLE_PREFERENCES).not.toContain('hooks')
    expect(RESETTABLE_PREFERENCES).not.toContain('lspServers')
  })
})

describe('export and import', () => {
  it('exports only preferences, never providers, MCP servers, or machine paths', () => {
    const text = exportPreferences(
      base({
        theme: 'dark',
        permissionRules: [{ action: 'deny', tool: '*', match: '*' }],
        additionalRoots: ['/home/me/secret'],
        mcpServers: [{ id: 'x', command: 'y', args: [], enabled: true, env: { TOKEN: 'abc' } }]
      }),
      new Date('2026-10-22T00:00:00Z')
    )
    const parsed = JSON.parse(text)
    expect(parsed).toMatchObject({ format: 'houston-settings', version: 1, exportedAt: '2026-10-22T00:00:00.000Z' })
    expect(Object.keys(parsed.settings).every((k) => (PREFERENCE_KEYS as string[]).includes(k))).toBe(true)
    expect(text).not.toMatch(/secret|abc|providers|mcpServers/)
  })

  it('round-trips what it exports', () => {
    const s = base({ theme: 'light', verbosity: 'high', hooks: [{ event: 'Stop', matcher: '*', command: 'make' }] })
    const res = parsePreferencesImport(exportPreferences(s))
    expect(res.ok && res.settings).toMatchObject({ theme: 'light', verbosity: 'high', hooks: s.hooks })
  })

  it('ignores and reports fields that are not preferences', () => {
    const res = parsePreferencesImport(
      JSON.stringify({ format: 'houston-settings', version: 1, settings: { theme: 'dark', providers: [], additionalRoots: ['/'] } })
    )
    expect(res).toEqual({ ok: true, settings: { theme: 'dark' }, keys: ['theme'], ignored: ['providers', 'additionalRoots'] })
  })

  it('rejects the whole file on a bad value, a bad rule, or a bad hook', () => {
    const file = (settings: object): string => JSON.stringify({ format: 'houston-settings', version: 1, settings })
    expect(parsePreferencesImport(file({ theme: 'neon' }))).toEqual({ ok: false, error: '"theme" has a value Houston does not accept.' })
    expect(parsePreferencesImport(file({ approvalPolicy: 'yolo' })).ok).toBe(false)
    expect(parsePreferencesImport(file({ webReads: 'always' })).ok).toBe(false)
    expect(parsePreferencesImport(file({ permissionRules: [{ acton: 'allow', tool: '*', match: '*' }] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining('unknown field "acton"')
    })
    expect(parsePreferencesImport(file({ hooks: [{ event: 'Boot', matcher: '*', command: 'x' }] })).ok).toBe(false)
  })

  it('rejects something that is not an export', () => {
    expect(parsePreferencesImport('nope')).toEqual({ ok: false, error: 'This file is not valid JSON.' })
    expect(parsePreferencesImport('{"theme":"dark"}')).toEqual({ ok: false, error: 'This is not a Houston settings export.' })
    expect(parsePreferencesImport('{"format":"houston-settings","version":2,"settings":{}}')).toEqual({
      ok: false,
      error: 'This export is from a newer version of Houston.'
    })
  })
})

describe('import checks per preference', () => {
  const file = (settings: object): string => JSON.stringify({ format: 'houston-settings', version: 1, settings })
  // One value each preference accepts, and one it must refuse.
  const cases: Array<[string, unknown, unknown]> = [
    ['approvalPolicy', 'full-auto', 'sometimes'],
    ['webReads', 'allow', 'always'],
    ['systemPromptExtra', 'be brief', 42],
    ['compactionThreshold', 0, -1],
    ['shellOutputMaxBytes', 65536, 10],
    ['maxIterations', 40, 1.5],
    ['autoExtendTurns', false, 'no'],
    ['maxIterationsCeiling', 200, 0],
    ['costCeilingUsd', 2.5, Number.NaN],
    ['stallDetection', true, 1],
    ['verifyOnStop', true, 'yes'],
    ['verifyCommand', 'npm test', ['npm']],
    ['subagentHistoryMb', 16, 5000],
    ['reasoningSummary', 'concise', 'short'],
    ['verbosity', 'low', 'loud'],
    ['searchProvider', 'tavily', null],
    ['lspEnabled', false, 'off'],
    ['lspServers', [{ id: 'lua', command: 'lua-ls', extensions: ['lua'] }], [{ id: 'lua', command: 'lua-ls' }]],
    ['formatOnSave', true, 'true'],
    ['diagnosticsOnSave', false, 0],
    ['desktopNotifications', false, null],
    ['theme', 'dark', 'sepia'],
    ['htmlVisuals', true, {}],
    ['keybindings', { 'open-settings': 'Mod+,', 'toggle-sidebar': null }, { 'open-settings': 5 }],
    ['sandboxEgress', { mode: 'allowlist', allow: ['corp.example'], deny: [] }, { mode: 'open' }]
  ]

  it.each(cases)('%s: accepts a valid value and refuses an invalid one', (key, good, bad) => {
    expect(parsePreferencesImport(file({ [key]: good }))).toMatchObject({ ok: true, keys: [key] })
    expect(parsePreferencesImport(file({ [key]: bad })).ok).toBe(false)
  })

  it('covers every preference except the two validated on their own', () => {
    const tested = new Set(cases.map(([k]) => k))
    expect(PREFERENCE_KEYS.filter((k) => !tested.has(k)).sort()).toEqual(['hooks', 'permissionRules'])
  })

  it('refuses egress lists that are not lists of domains', () => {
    expect(parsePreferencesImport(file({ sandboxEgress: { allow: 'corp.example' } })).ok).toBe(false)
    expect(parsePreferencesImport(file({ sandboxEgress: { deny: [3] } })).ok).toBe(false)
    expect(parsePreferencesImport(file({ sandboxEgress: [] })).ok).toBe(false)
  })

  it('refuses hooks that are not a list of complete hooks', () => {
    expect(parsePreferencesImport(file({ hooks: { event: 'Stop' } })).ok).toBe(false)
    expect(parsePreferencesImport(file({ hooks: [{ event: 'Stop', matcher: '*' }] })).ok).toBe(false)
    expect(parsePreferencesImport(file({ hooks: [null] })).ok).toBe(false)
  })
})
