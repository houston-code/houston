import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppSettings } from '@shared/types'
import { parsePreferencesImport, exportPreferences } from '@shared/settingsPortable'
import {
  importSummary,
  maskProxyUrl,
  MAX_TEXT_SETTING_CHARS,
  parseSettingsCommand,
  renderAccessSummary,
  renderSettingValues,
  settableKey,
  settingChange,
  SETTABLE
} from './tui-settings-set'
import type { Painter } from './tui'

const plain: Painter = (s) => s
const base = (over: Partial<AppSettings> = {}): AppSettings =>
  ({ schemaVersion: 1, providers: [], selected: null, ...over }) as AppSettings
const ctx = { cwd: '/work', home: '/home/me' }

/** Apply a `/settings` line to settings, as the driver does; the message or the error. */
function apply(line: string, s: AppSettings = base()): { settings: AppSettings; text: string; ok: boolean } {
  const cmd = parseSettingsCommand(line)
  if (cmd.op !== 'set' && cmd.op !== 'unset' && cmd.op !== 'add' && cmd.op !== 'remove') throw new Error(cmd.op)
  const r = settingChange(cmd, s, ctx)
  if ('error' in r) return { settings: s, text: r.error, ok: false }
  return { settings: { ...s, ...r.patch }, text: r.message, ok: true }
}

describe('parseSettingsCommand', () => {
  it('reads each verb, and anything else as a page', () => {
    expect(parseSettingsCommand('')).toEqual({ op: 'overview' })
    expect(parseSettingsCommand('get')).toEqual({ op: 'get' })
    expect(parseSettingsCommand('get maxIterations')).toEqual({ op: 'get', key: 'maxIterations' })
    expect(parseSettingsCommand('set verifyCommand npm run typecheck && npm test')).toEqual({
      op: 'set',
      key: 'verifyCommand',
      value: 'npm run typecheck && npm test'
    })
    expect(parseSettingsCommand('unset proxyUrl')).toEqual({ op: 'unset', key: 'proxyUrl' })
    expect(parseSettingsCommand('add additionalRoots ../shared lib')).toEqual({
      op: 'add',
      key: 'additionalRoots',
      value: '../shared lib'
    })
    expect(parseSettingsCommand('rm additionalRoots 2')).toEqual({ op: 'remove', key: 'additionalRoots', value: '2' })
    expect(parseSettingsCommand('export ~/prefs.json')).toEqual({ op: 'export', path: '~/prefs.json' })
    expect(parseSettingsCommand('import my prefs.json')).toEqual({ op: 'import', path: 'my prefs.json' })
    expect(parseSettingsCommand('reset')).toEqual({ op: 'reset' })
    expect(parseSettingsCommand('search-key brave')).toEqual({ op: 'search-key', provider: 'brave' })
    expect(parseSettingsCommand('agent behavior')).toEqual({ op: 'page', page: 'agent behavior' })
  })

  it('never reads a missing value as a clear', () => {
    expect(parseSettingsCommand('set maxIterations').op).toBe('usage')
    expect(parseSettingsCommand('set').op).toBe('usage')
    expect(parseSettingsCommand('export').op).toBe('usage')
    expect(parseSettingsCommand('reset everything').op).toBe('usage')
    expect(parseSettingsCommand('add additionalRoots').op).toBe('usage')
  })
})

describe('settingChange: the allowlist', () => {
  it('refuses a setting outside it, and never takes a key or token', () => {
    const r = apply('set providers []')
    expect(r.ok).toBe(false)
    expect(r.text).toContain("isn't a setting the terminal changes")
    for (const name of ['searchKey', 'apiKey', 'githubToken', 'password']) {
      const k = apply(`set ${name} sk-live-123`)
      expect(k.ok).toBe(false)
      expect(k.text).toContain('API keys are never set with /settings set')
      // The secret itself is never echoed back.
      expect(k.text).not.toContain('sk-live-123')
    }
    // Neither the egress lists nor the approval mode, the permission rules, or hooks.
    for (const name of ['sandboxEgress', 'approvalPolicy', 'permissionRules', 'hooks', 'mcpServers', 'trustedFolders']) {
      expect(apply(`set ${name} x`).ok, name).toBe(false)
    }
  })

  it('takes key names in any case', () => {
    expect(settableKey('MAXITERATIONS')).toBe('maxIterations')
    expect(apply('set maxiterations 50').settings.maxIterations).toBe(50)
  })

  it('holds numbers to their type and range', () => {
    expect(apply('set maxIterations 0').ok).toBe(false)
    expect(apply('set maxIterations 2.5').ok).toBe(false)
    expect(apply('set maxIterations -3').ok).toBe(false)
    expect(apply('set maxIterations 1e9').ok).toBe(false)
    expect(apply('set maxIterations 99999999999999999999').ok).toBe(false)
    expect(apply('set shellOutputMaxBytes 999').ok).toBe(false)
    expect(apply('set shellOutputMaxBytes 50_000').settings.shellOutputMaxBytes).toBe(50000)
    expect(apply('set subagentHistoryMb 1025').ok).toBe(false)
    expect(apply('set subagentHistoryMb 0').settings.subagentHistoryMb).toBe(0)
    expect(apply('set costCeilingUsd $2.50').settings.costCeilingUsd).toBe(2.5)
    expect(apply('set costCeilingUsd NaN').ok).toBe(false)
    expect(apply('set maxIterationsCeiling 400').settings.maxIterationsCeiling).toBe(400)
  })

  it('setting the step cap pins autoExtendTurns to what it was, as the desktop does', () => {
    // Unset cap and unset switch: extension is on, and stays on once a cap is set.
    expect(apply('set maxIterations 80').settings.autoExtendTurns).toBe(true)
    expect(apply('set maxIterations 80', base({ maxIterations: 40 })).settings.autoExtendTurns).toBe(false)
    expect(apply('set maxIterations 80', base({ autoExtendTurns: true, maxIterations: 40 })).settings.autoExtendTurns).toBe(true)
  })

  it('reads booleans and choices', () => {
    expect(apply('set verifyOnStop on').settings.verifyOnStop).toBe(true)
    expect(apply('set stallDetection OFF').settings.stallDetection).toBe(false)
    expect(apply('set stallDetection maybe').ok).toBe(false)
    expect(apply('set reasoningSummary Detailed').settings.reasoningSummary).toBe('detailed')
    expect(apply('set verbosity loud').ok).toBe(false)
    expect(apply('set searchProvider brave').settings.searchProvider).toBe('brave')
    expect(apply('set searchProvider google').ok).toBe(false)
  })

  it('compaction: auto, off, a share, or a token count, storing only the field the mode uses', () => {
    const pct = apply('set compactionThreshold 70%', base({ compactionThreshold: 5000 }))
    expect(pct.settings.compactionThresholdPercent).toBe(70)
    expect(pct.settings.compactionThreshold).toBeUndefined()
    const tok = apply('set compactionThreshold 120000', base({ compactionThresholdPercent: 50 }))
    expect(tok.settings.compactionThreshold).toBe(120000)
    expect(tok.settings.compactionThresholdPercent).toBeUndefined()
    expect(apply('set compactionThreshold off').settings.compactionThreshold).toBe(0)
    const auto = apply('set compactionThreshold auto', base({ compactionThreshold: 0 }))
    expect(auto.settings.compactionThreshold).toBeUndefined()
    expect(auto.text).toContain('auto')
    expect(apply('set compactionThreshold 101%').ok).toBe(false)
    expect(apply('set compactionThreshold 0%').ok).toBe(false)
    expect(apply('set compactionThreshold 999').ok).toBe(false)
  })

  it('proxy: only an http or https URL, and a password in it is never shown', () => {
    expect(apply('set proxyUrl socks5://p:1080').ok).toBe(false)
    expect(apply('set proxyUrl proxy.corp:8080').ok).toBe(false)
    const r = apply('set proxyUrl http://me:hunter2@proxy.corp:8080')
    expect(r.settings.proxyUrl).toBe('http://me:hunter2@proxy.corp:8080')
    expect(r.text).toContain('me:***@proxy.corp:8080')
    expect(r.text).not.toContain('hunter2')
    expect(maskProxyUrl('http://proxy.corp:8080')).toBe('http://proxy.corp:8080')
    expect(apply('unset proxyUrl', r.settings).settings.proxyUrl).toBeUndefined()
  })

  it('text settings keep the value as typed, up to a cap', () => {
    expect(apply('set verifyCommand npm test && npm run lint').settings.verifyCommand).toBe('npm test && npm run lint')
    expect(apply(`set systemPromptExtra ${'x'.repeat(MAX_TEXT_SETTING_CHARS + 1)}`).ok).toBe(false)
  })

  it('webReads allow says what it changes', () => {
    const r = apply('set webReads allow')
    expect(r.settings.webReads).toBe('allow')
    expect(r.text).toContain('without asking')
    expect(apply('set webReads always').ok).toBe(false)
  })

  it('unset puts a setting back to its default', () => {
    const r = apply('unset maxIterations', base({ maxIterations: 5 }))
    expect(r.settings.maxIterations).toBeUndefined()
    expect(r.text).toContain('(default)')
  })
})

describe('additionalRoots', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tui-roots-')))
  mkdirSync(join(root, 'shared'))
  writeFileSync(join(root, 'file.txt'), 'x')
  const here = { cwd: root, home: root }
  const run = (line: string, s: AppSettings) => {
    const cmd = parseSettingsCommand(line) as Parameters<typeof settingChange>[0]
    return settingChange(cmd, s, here)
  }

  it('adds an existing directory, resolved from the working folder, and says what it allows', () => {
    const r = run('add additionalRoots shared', base())
    expect('patch' in r && r.patch.additionalRoots).toEqual([join(root, 'shared')])
    expect('message' in r && r.message).toContain('read and write')
    const home = run('add additionalRoots ~/shared', base())
    expect('patch' in home && home.patch.additionalRoots).toEqual([join(root, 'shared')])
  })

  it('refuses a file, a missing path, a duplicate, and a plain set', () => {
    expect('error' in run('add additionalRoots file.txt', base())).toBe(true)
    expect('error' in run('add additionalRoots nope', base())).toBe(true)
    expect('error' in run('add additionalRoots shared', base({ additionalRoots: [join(root, 'shared')] }))).toBe(true)
    const set = run('set additionalRoots /', base())
    expect('error' in set && set.error).toContain('is a list')
  })

  it('removes one by number or by path', () => {
    const s = base({ additionalRoots: ['/a', join(root, 'shared')] })
    const byN = run('remove additionalRoots 1', s)
    expect('patch' in byN && byN.patch.additionalRoots).toEqual([join(root, 'shared')])
    const byPath = run('remove additionalRoots shared', s)
    expect('patch' in byPath && byPath.patch.additionalRoots).toEqual(['/a'])
    expect('error' in run('remove additionalRoots 7', s)).toBe(true)
  })
})

describe('renderSettingValues', () => {
  it('lists every settable key by page', () => {
    const out = renderSettingValues(base({ maxIterations: 12 }), plain)
    for (const k of Object.keys(SETTABLE)) expect(out, k).toContain(k)
    expect(out).toContain('Agent Behavior')
    expect(out).toMatch(/maxIterations\s+12/)
  })

  it('one key: its value, what it takes, and for verifyCommand the suggested one', () => {
    const out = renderSettingValues(base(), plain, 'verifyCommand', {
      verifySuggestion: { command: 'npm test', source: 'package.json script test' }
    })
    expect(out).toContain('verifyCommand = (empty)')
    expect(out).toContain('For this project: npm test (from package.json script test)')
    expect(renderSettingValues(base(), plain, 'shellOutputMaxBytes')).toContain('1000 or more')
  })

  it('shows whether the web search provider has a key, never the key', () => {
    const out = renderSettingValues(base({ searchProvider: 'exa', searchKeyStatus: { exa: true } }), plain, 'searchProvider')
    expect(out).toContain('exa, key set')
  })
})

describe('renderAccessSummary', () => {
  it('shows web reads, extra folders, and the egress lists read-only', () => {
    const out = renderAccessSummary(
      base({ webReads: 'allow', additionalRoots: ['/data'], sandboxEgress: { allow: ['corp.example'], deny: ['evil.example'] } }),
      plain
    )
    expect(out).toContain('allow without asking')
    expect(out).toContain('/data')
    expect(out).toContain('added:  corp.example')
    expect(out).toContain('denied: evil.example')
    expect(out).toContain('edited in the desktop app')
  })

  it('calls out all-domains egress', () => {
    expect(renderAccessSummary(base({ sandboxEgress: { mode: 'all' } }), plain)).toContain('all domains')
  })
})

describe('importSummary', () => {
  it('names what it replaces and flags what widens access', () => {
    const file = exportPreferences(
      base({
        maxIterations: 9,
        webReads: 'allow',
        approvalPolicy: 'full-auto',
        sandboxEgress: { mode: 'all' },
        permissionRules: [{ tool: 'run_shell', match: 'npm *', action: 'allow' }],
        hooks: [{ event: 'PostToolUse', matcher: '*', command: 'echo hi' }]
      })
    )
    const parsed = parsePreferencesImport(file)
    if (!parsed.ok) throw new Error(parsed.error)
    const text = importSummary(parsed).join('\n')
    expect(text).toContain('maxIterations')
    expect(text).toContain('1 rule that allows calls without asking and 1 hook that runs shell commands')
    expect(text).toContain('full-auto')
    expect(text).toContain('every domain')
    expect(text).toContain('read web pages without asking')
  })
})
