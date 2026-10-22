import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'
import { LICENSE_URL, PRIVACY_URL } from '@shared/legal'
import { updateErrorHint, type UpdateCheckResult } from '@shared/update'
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
