import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { LICENSE_URL, PRIVACY_URL } from '@shared/legal'
import { updateErrorHint, type UpdateCheckResult } from '@shared/update'
import {
  exportPreferences,
  parsePreferencesImport,
  resetPreferences,
  RESETTABLE_PREFERENCES,
  type ParsedImport,
  type PreferenceKey
} from '@shared/settingsPortable'
import { SettingsSection } from '../fields'
import { KeyboardTab } from '../KeyboardTab'
import type { SettingsCtx } from '../context'

export function AppearanceSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection
      title="Appearance"
      desc="Choose how Houston looks; System follows your OS setting."
    >
      <label className="field">
        <span>Color theme</span>
        <select
          value={settings.theme ?? 'system'}
          onChange={(e) =>
            setSettings((s) => ({ ...s, theme: e.target.value as AppSettings['theme'] }))
          }
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </label>
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={settings.htmlVisuals ?? false}
          onChange={(e) => setSettings((s) => ({ ...s, htmlVisuals: e.target.checked }))}
        />
        <span>
          Run interactive visuals in the chat. When the agent writes an HTML visual (a small
          chart or control you can interact with), run it in a sandboxed frame with no network
          access. Diagrams and images show either way. Off by default.
        </span>
      </label>
    </SettingsSection>
  )
}

export function NotificationsSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  return (
    <SettingsSection title="Notifications">
      <label className="field field--checkbox">
        <input
          type="checkbox"
          checked={settings.desktopNotifications ?? true}
          onChange={(e) =>
            setSettings((s) => ({ ...s, desktopNotifications: e.target.checked }))
          }
        />
        <span>
          Show a desktop notification when the agent finishes a turn, needs approval,
          asks a question, or opens/merges a pull request while Houston isn’t the focused
          window. On by default.
        </span>
      </label>
    </SettingsSection>
  )
}

/** The installed version, and a manual check for new releases. */
export function UpdatesSection(): JSX.Element {
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult | null>(null)
  useEffect(() => {
    void window.api.getVersion().then(setVersion)
  }, [])
  const checkForUpdates = async (): Promise<void> => {
    setChecking(true)
    setUpdateResult(null)
    try {
      setUpdateResult(await window.api.checkForUpdates())
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingsSection
      title="Updates"
      desc="Your installed version, and a manual check for new releases."
    >
      <div className="updates-row">
        <span className="updates-row__version">Houston {version || '–'}</span>
        <button
          className="btn btn--sm"
          onClick={() => void checkForUpdates()}
          disabled={checking}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>
      {updateResult && (
        <p className="updates-status">
          {updateResult.status === 'available' && (
            <>
              Houston <strong>{updateResult.latestVersion}</strong> is available.{' '}
              <a href={updateResult.releaseUrl} target="_blank" rel="noreferrer">
                Download
              </a>
            </>
          )}
          {updateResult.status === 'up-to-date' && 'You’re on the latest version.'}
          {updateResult.status === 'disabled' &&
            'Update checks run only in packaged builds.'}
          {updateResult.status === 'error' &&
            ['Couldn’t check for updates.', updateErrorHint(updateResult.message)]
              .filter(Boolean)
              .join(' ')}
        </p>
      )}
    </SettingsSection>
  )
}

export function LegalSection(): JSX.Element {
  return (
    <SettingsSection
      title="Legal"
      desc="How Houston handles your data, and the open-source license Houston itself ships under."
    >
      <p className="settings-legal__links">
        <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
          Privacy
        </a>
        {' · '}
        <a href={LICENSE_URL} target="_blank" rel="noreferrer">
          License (Apache-2.0)
        </a>
      </p>
    </SettingsSection>
  )
}

/** The rebindable keyboard shortcuts. */
export function KeyboardSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const setKeybind = (id: string, value: string | null): void =>
    setSettings((s) => ({ ...s, keybindings: { ...(s.keybindings ?? {}), [id]: value } }))
  const resetKeybind = (id: string): void =>
    setSettings((s) => {
      const next = { ...(s.keybindings ?? {}) }
      delete next[id]
      return { ...s, keybindings: next }
    })
  const resetAllKeybinds = (): void => setSettings((s) => ({ ...s, keybindings: {} }))

  return (
    <KeyboardTab
      overrides={settings.keybindings}
      onSet={setKeybind}
      onReset={resetKeybind}
      onResetAll={resetAllKeybinds}
    />
  )
}

/** Run the setup health check (the same as /doctor). */
export function DiagnosticsCheckSection({ ctx }: { ctx: SettingsCtx }): JSX.Element | null {
  const { onShowDoctor } = ctx
  if (!onShowDoctor) return null
  return (
    <SettingsSection
      title="Diagnostics"
      desc="Check your setup: the selected model and its key, the sandbox, optional tools, and MCP servers."
    >
      <button type="button" className="btn btn--sm" onClick={onShowDoctor}>
        Run diagnostics
      </button>
    </SettingsSection>
  )
}

/** How each preference is named in the import summary. */
const PREFERENCE_LABEL: Record<PreferenceKey, string> = {
  approvalPolicy: 'approval mode',
  webReads: 'web reads in full auto',
  permissionRules: 'permission rules',
  hooks: 'hooks',
  systemPromptExtra: 'system prompt addition',
  compactionThreshold: 'compaction threshold',
  shellOutputMaxBytes: 'command output limit',
  maxIterations: 'steps per turn',
  autoExtendTurns: 'keep going while productive',
  maxIterationsCeiling: 'step limit',
  costCeilingUsd: 'cost reminder',
  stallDetection: 'loop detection',
  verifyOnStop: 'verify on finish',
  verifyCommand: 'verification command',
  subagentHistoryMb: 'subagent history',
  reasoningSummary: 'reasoning summary',
  verbosity: 'verbosity',
  searchProvider: 'web search provider',
  lspEnabled: 'language servers',
  lspServers: 'extra language servers',
  formatOnSave: 'format on save',
  diagnosticsOnSave: 'diagnostics on save',
  desktopNotifications: 'notifications',
  theme: 'theme',
  htmlVisuals: 'interactive visuals',
  keybindings: 'keyboard shortcuts',
  sandboxEgress: 'sandbox egress'
}

type ReadyImport = Extract<ParsedImport, { ok: true }>

/**
 * Export the preferences to a file, import them from one (after a summary of what
 * it changes), or reset them to the defaults. Providers, keys, MCP servers, and
 * this machine's folders are never part of it; see @shared/settingsPortable.
 */
export function PreferencesSection({ ctx }: { ctx: SettingsCtx }): JSX.Element {
  const { settings, setSettings } = ctx
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null)
  const [pending, setPending] = useState<ReadyImport | null>(null)
  const [confirmingReset, setConfirmingReset] = useState(false)

  const doExport = async (): Promise<void> => {
    setStatus(null)
    try {
      const path = await window.api.exportSettingsFile(exportPreferences(settings))
      if (path) setStatus({ text: `Exported to ${path}.` })
    } catch (e) {
      setStatus({ text: `Could not export: ${(e as Error).message}`, error: true })
    }
  }

  const doImport = async (): Promise<void> => {
    setStatus(null)
    setConfirmingReset(false)
    try {
      const text = await window.api.importSettingsFile()
      if (text === null) return
      const parsed = parsePreferencesImport(text)
      if (!parsed.ok) setStatus({ text: parsed.error, error: true })
      else if (parsed.keys.length === 0) setStatus({ text: 'That file holds no preferences to import.', error: true })
      else setPending(parsed)
    } catch (e) {
      setStatus({ text: `Could not import: ${(e as Error).message}`, error: true })
    }
  }

  // What the import brings that deserves a second look: rules that allow, hooks that run commands.
  const allowRules = pending?.settings.permissionRules?.filter((r) => r.action === 'allow').length ?? 0
  const hookCount = pending?.settings.hooks?.length ?? 0

  return (
    <SettingsSection
      title="Your preferences"
      desc="Move your preferences to another machine, or start over. Providers, API keys, MCP servers, and folders are not included."
    >
      <div className="field__row">
        <button className="btn btn--sm" onClick={() => void doExport()}>
          Export…
        </button>
        <button className="btn btn--sm" onClick={() => void doImport()}>
          Import…
        </button>
        <button
          className="btn btn--sm btn--danger"
          onClick={() => {
            setPending(null)
            setConfirmingReset(true)
          }}
        >
          Reset preferences…
        </button>
      </div>

      {pending && (
        <div className="confirm-panel" role="group" aria-label="Confirm import">
          <p>
            Import replaces your {pending.keys.map((k) => PREFERENCE_LABEL[k]).join(', ')}.
          </p>
          {(allowRules > 0 || hookCount > 0) && (
            <p className="confirm-panel__warn">
              It includes{' '}
              {[
                allowRules > 0 ? `${allowRules} ${allowRules === 1 ? 'rule' : 'rules'} that allow calls without asking` : '',
                hookCount > 0 ? `${hookCount} ${hookCount === 1 ? 'hook that runs' : 'hooks that run'} shell commands` : ''
              ]
                .filter(Boolean)
                .join(' and ')}
              . Import only a file you trust.
            </p>
          )}
          {pending.ignored.length > 0 && (
            <p className="settings-dim">Not imported (not preferences): {pending.ignored.join(', ')}.</p>
          )}
          <div className="confirm-panel__actions">
            <button className="btn btn--sm" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button
              className="btn btn--sm btn--accent"
              onClick={() => {
                setSettings((s) => ({ ...s, ...pending.settings }))
                setPending(null)
                setStatus({ text: 'Imported. Undo is at the top if you change your mind.' })
              }}
            >
              Import
            </button>
          </div>
        </div>
      )}

      {confirmingReset && (
        <div className="confirm-panel" role="group" aria-label="Confirm reset">
          <p>
            Reset every preference to its default? Your providers, API keys, MCP servers, permission rules,
            hooks, and approval mode stay as they are.
          </p>
          <div className="confirm-panel__actions">
            <button className="btn btn--sm" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
            <button
              className="btn btn--sm btn--danger"
              onClick={() => {
                setSettings((s) => resetPreferences(s, RESETTABLE_PREFERENCES))
                setConfirmingReset(false)
                setStatus({ text: 'Preferences reset. Undo is at the top if you change your mind.' })
              }}
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {status && (
        <p className={`field__hint${status.error ? ' field__hint--warn' : ''}`} role={status.error ? 'alert' : 'status'}>
          {status.text}
        </p>
      )}
    </SettingsSection>
  )
}
