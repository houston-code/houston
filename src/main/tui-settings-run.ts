import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AppSettings } from '@shared/types'
import { assertNever } from '@shared/assert'
import {
  exportPreferences,
  parsePreferencesImport,
  RESETTABLE_PREFERENCES
} from '@shared/settingsPortable'
import { getSearchProviderInfo, SEARCH_PROVIDERS } from '@shared/search'
import type { Painter } from './tui'
import { renderSettingsOverview, renderSettingsPage, type TerminalLiveSettings } from './tui-settings'
import {
  importSummary,
  renderSettingValues,
  settingChange,
  type SettingsCommand
} from './tui-settings-set'
import { writeExportFile } from './tui-sessions'
import { stripControlChars } from './tui-wrap'

/** Largest file `/settings import` reads, as the desktop's import does. */
export const MAX_SETTINGS_IMPORT_BYTES = 2_000_000

/** What `/settings` needs from the terminal session. */
export interface SettingsEnv {
  getSettings: () => AppSettings
  /** Merge a patch into the shared settings.json (re-read first). Absent: read-only. */
  updateSettings?: (patch: Partial<AppSettings>) => void
  /** Store a secret by id, as `/login` does. Absent: no writable key store. */
  setKey?: (id: string, key: string) => { shadowedByEnv: string | null }
  settingsPath: string
  cwd: string
  live: TerminalLiveSettings
  out: (s: string) => void
  readLine: (prompt: string, opts?: { discardPending?: boolean }) => Promise<string | null>
  readSecret?: (prompt: string) => Promise<string | null>
  /** The verification command this folder suggests (`/settings get verifyCommand`). */
  inferVerifyCommand?: (cwd: string) => { command: string; source: string } | null
  paint: Painter
  home?: string
}

function resolvePath(path: string, env: SettingsEnv): string {
  const home = env.home ?? homedir()
  const p = path.trim()
  const expanded = p === '~' || p.startsWith('~/') ? join(home, p.slice(1)) : p
  return resolve(env.cwd, expanded)
}

async function confirm(env: SettingsEnv, question: string): Promise<boolean> {
  const a = (await env.readLine(`${question} [y/N] `, { discardPending: true }))?.trim().toLowerCase()
  return a === 'y' || a === 'yes'
}

/** Carry out one `/settings` command. Prints everything it has to say. */
export async function runSettingsCommand(cmd: SettingsCommand, env: SettingsEnv): Promise<void> {
  const { paint, out } = env
  const say = (s: string, style?: Parameters<Painter>[1]): void => out(`${style ? paint(s, style) : s}\n`)
  switch (cmd.op) {
    case 'overview':
      say(renderSettingsOverview(env.settingsPath, env.live, paint))
      return
    case 'page':
      say(renderSettingsPage(cmd.page, paint))
      return
    case 'usage':
      say(`· ${cmd.message}`, 'dim')
      return
    case 'get': {
      const wantsVerify = cmd.key?.toLowerCase() === 'verifycommand'
      const suggestion = wantsVerify ? (env.inferVerifyCommand?.(env.cwd) ?? null) : null
      say(renderSettingValues(env.getSettings(), paint, cmd.key, { verifySuggestion: suggestion }))
      return
    }
    case 'set':
    case 'unset':
    case 'add':
    case 'remove': {
      if (!env.updateSettings) {
        say('· changing settings is unavailable here', 'dim')
        return
      }
      // Checked against the settings as they are now (another process may have saved
      // since), and merged as a patch, never as a whole copy.
      const change = settingChange(cmd, env.getSettings(), { cwd: env.cwd, ...(env.home ? { home: env.home } : {}) })
      if ('error' in change) {
        say(change.error, 'yellow')
        return
      }
      env.updateSettings(change.patch)
      say(change.message, 'dim')
      const s = env.getSettings()
      if (cmd.op === 'set' && 'verifyOnStop' in change.patch && s.verifyOnStop && !(s.verifyCommand ?? '').trim()) {
        const sug = env.inferVerifyCommand?.(env.cwd)
        say(
          sug
            ? `· no verifyCommand set: full auto runs ${stripControlChars(sug.command)} (from ${stripControlChars(sug.source)}), other modes run nothing`
            : '· no verifyCommand set: nothing runs until you set one (/settings set verifyCommand <command>)',
          'dim'
        )
      }
      return
    }
    case 'export': {
      const text = exportPreferences(env.getSettings())
      try {
        const path = writeExportFile(env.cwd, cmd.path.trim(), text)
        say(`· exported your preferences to ${stripControlChars(path)} (no providers, API keys, MCP servers, or folders)`, 'green')
      } catch (e) {
        say(`· could not export: ${stripControlChars((e as Error).message)}`, 'red')
      }
      return
    }
    case 'import': {
      if (!env.updateSettings) {
        say('· changing settings is unavailable here', 'dim')
        return
      }
      const path = resolvePath(cmd.path, env)
      let text: string
      try {
        const st = statSync(path)
        if (!st.isFile()) throw new Error(`${path} is not a file`)
        // Size-checked before reading, so a huge file is refused without loading it.
        if (st.size > MAX_SETTINGS_IMPORT_BYTES) throw new Error('that file is too large to be a settings export')
        text = readFileSync(path, 'utf8')
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        say(`· could not import: ${code === 'ENOENT' ? `no file at ${path}` : (e as Error).message}`.replace(/[\r\n]+/g, ' '), 'red')
        return
      }
      const parsed = parsePreferencesImport(text)
      if (!parsed.ok) {
        say(`· could not import: ${parsed.error}`, 'red')
        return
      }
      if (parsed.keys.length === 0) {
        say('· that file holds no preferences to import', 'yellow')
        return
      }
      for (const line of importSummary(parsed)) say(line, line.includes('trust') ? 'yellow' : 'dim')
      if (!(await confirm(env, 'Import?'))) {
        say('· nothing imported', 'dim')
        return
      }
      env.updateSettings(parsed.settings)
      say(`· imported ${parsed.keys.length} preference${parsed.keys.length === 1 ? '' : 's'}`, 'green')
      return
    }
    case 'reset': {
      if (!env.updateSettings) {
        say('· changing settings is unavailable here', 'dim')
        return
      }
      say('· this resets every preference to its default; your providers, API keys, MCP servers, permission rules, hooks, and approval mode stay', 'dim')
      if (!(await confirm(env, 'Reset preferences?'))) {
        say('· nothing reset', 'dim')
        return
      }
      env.updateSettings(Object.fromEntries(RESETTABLE_PREFERENCES.map((k) => [k, undefined])) as Partial<AppSettings>)
      say('· preferences reset to their defaults', 'green')
      return
    }
    case 'search-key': {
      const id = (cmd.provider ?? env.getSettings().searchProvider ?? '').toLowerCase()
      if (cmd.provider && !SEARCH_PROVIDERS.some((p) => p.id === id)) {
        say(`· no web search provider "${stripControlChars(cmd.provider)}"; one of ${SEARCH_PROVIDERS.map((p) => p.id).join(', ')}`, 'yellow')
        return
      }
      const info = getSearchProviderInfo(id || undefined)
      if (!env.setKey) {
        say('· storing keys is unavailable here', 'dim')
        return
      }
      say(`${info.label}: get a key at ${info.keyUrl}`, 'dim')
      say('Paste the API key (hidden; not saved to shell or session history):', 'dim')
      const read = env.readSecret ?? env.readLine
      const key = (await read(paint('key › ', 'green')))?.trim() ?? ''
      if (!key) {
        say('· no key entered, nothing changed', 'dim')
        return
      }
      const { shadowedByEnv } = env.setKey(info.keyId, key)
      say(`· key saved for ${info.label} web search (owner-only, on this profile)`, 'dim')
      if (shadowedByEnv) say(`· note: ${shadowedByEnv} is set in your environment and is used instead`, 'yellow')
      if ((env.getSettings().searchProvider ?? '') !== info.id && cmd.provider) {
        say(`· /settings set searchProvider ${info.id} makes it the one web_search uses`, 'dim')
      }
      return
    }
    default:
      assertNever(cmd, 'settings command')
  }
}
