import { useEffect, useRef, useState } from 'react'
import { SecureStorageNotice, secureStorageBlocked } from './SecureStorageNotice'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useApplyTheme } from '../hooks/useApplyTheme'
import { applyTheme } from '../lib/theme'
import type { AppSettings } from '@shared/types'
import { PAGES, type TabId } from './settings/pages'
import { NAV_ICON } from './settings/navIcons'
import { TOOL_NAMES } from './settings/permissionRules'
import type { SettingsCtx } from './settings/context'

export { KeyboardTab } from './settings/KeyboardTab'
export type { TabId } from './settings/pages'

export function SettingsModal({
  initial,
  initialTab = 'models',
  onClose,
  onSaved,
  onShowScorecard
}: {
  initial: AppSettings
  /** The section to open on (e.g. Appearance for /theme). */
  initialTab?: TabId
  onClose: () => void
  onSaved: (s: AppSettings) => void
  /** Open the local-only per-model loop scorecard (from the Models tab). */
  onShowScorecard?: () => void
}): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(initial)
  const [tab, setTab] = useState<TabId>(initialTab)
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  // A key/model action error, shown inline in the footer (vs a blocking alert()).
  const [formError, setFormError] = useState<string | null>(null)
  // Set to the platform when a key save failed because the OS secure store is unusable.
  const [storageBlocked, setStorageBlocked] = useState<string | null>(null)
  // True once a close is requested while there are unsaved edits — the footer then
  // asks to confirm rather than discarding silently.
  const [confirmingClose, setConfirmingClose] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  // A stable digest of the persisted-settings baseline (derived key flags stripped,
  // since those change via the key actions, not "unsaved edits"). Updated whenever
  // the working settings are persisted, so the dirty check reflects real edits.
  const digest = (s: AppSettings): string =>
    JSON.stringify({
      ...s,
      providers: s.providers.map((p) => ({ ...p, hasKey: false })),
      searchKeyStatus: undefined
    })
  const savedDigest = useRef(digest(initial))
  const isDirty = digest(settings) !== savedDigest.current

  // Guard close (X / backdrop / Esc): warn once when there are unsaved edits.
  const requestClose = (): void => {
    if (isDirty) setConfirmingClose(true)
    else onClose()
  }
  useFocusTrap(modalRef, requestClose)

  // Live-preview the selected color theme while the modal is open, so the user
  // sees the change before committing. If they close without saving we revert to
  // whatever theme was active when the modal opened. `committed` guards the
  // revert: once Save persists the selection it becomes the real theme, so the
  // unmount cleanup must leave it in place. This is purely CSS-variable driven
  // (data-theme on <html>), so the preview behaves identically on macOS, Linux,
  // and Windows.
  useApplyTheme(settings.theme ?? 'system')
  const themeAtOpen = useRef<AppSettings['theme']>(initial.theme ?? 'system').current
  const committed = useRef(false)
  useEffect(
    () => () => {
      if (!committed.current) applyTheme(themeAtOpen ?? 'system')
    },
    [themeAtOpen]
  )

  // An API key lives in the OS secret store, not settings.json — so saving/removing
  // one is its own action and must NOT persist the modal's other (unsaved) edits.
  // We merge just the derived key flags from main's response into the working copy,
  // keeping every pending edit intact so Cancel still discards them.
  const applyKeyResult = (fresh: AppSettings, id: string, has: boolean): void =>
    setSettings((s) => ({
      ...s,
      providers: s.providers.map((p) => {
        const fp = fresh.providers.find((x) => x.id === p.id)
        // The just-(un)keyed provider is definitive; others take main's recomputed
        // flag (a new unsaved provider isn't in `fresh`, so fall back to `has`).
        return { ...p, hasKey: p.id === id ? has : (fp?.hasKey ?? p.hasKey) }
      }),
      searchKeyStatus: fresh.searchKeyStatus
    }))

  const saveKey = async (id: string): Promise<void> => {
    const key = keyInputs[id]?.trim()
    if (!key) return
    setBusy(id)
    setFormError(null)
    setStorageBlocked(null)
    try {
      applyKeyResult(await window.api.setKey(id, key), id, true)
      setKeyInputs((k) => ({ ...k, [id]: '' }))
    } catch (e) {
      // Surface storage failures instead of letting the key silently vanish. When the
      // OS secure store is the cause (a denied Keychain prompt), say how to recover.
      const blocked = await secureStorageBlocked()
      if (blocked) setStorageBlocked(blocked)
      else setFormError(`Could not save API key: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const removeKey = async (id: string): Promise<void> => {
    setBusy(id)
    setFormError(null)
    try {
      applyKeyResult(await window.api.deleteKey(id), id, false)
    } catch (e) {
      setFormError(`Could not remove API key: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  // Persist the working copy for an action main performs against the saved
  // settings. That commits the edits, including the previewed theme, so lock the
  // theme in too and refresh the dirty baseline.
  const persistNow = async (): Promise<void> => {
    await window.api.saveSettings(settings)
    committed.current = true
    savedDigest.current = digest(settings)
  }

  const save = async (): Promise<void> => {
    const fresh = await window.api.saveSettings(settings)
    // Lock in the previewed theme: skip the revert-on-unmount below.
    committed.current = true
    savedDigest.current = digest(settings)
    onSaved(fresh)
    onClose()
  }

  const ctx: SettingsCtx = {
    settings,
    setSettings,
    busy,
    setBusy,
    keyInputs,
    setKeyInputs,
    setFormError,
    saveKey,
    removeKey,
    persistNow,
    onShowScorecard
  }
  const page = PAGES.find((p) => p.id === tab) ?? PAGES[0]

  return (
    <div className="modal-backdrop" onClick={requestClose}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="settings-title">Settings</h2>
          <button className="modal__close" onClick={requestClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="modal__main">
          <nav className="modal__nav" aria-label="Settings sections">
            {PAGES.map((t) => (
              <button
                key={t.id}
                className={t.id === tab ? 'is-active' : ''}
                // The highlighted section is otherwise only a color and a rail.
                aria-current={t.id === tab ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="set-nav__icon" aria-hidden="true">
                  {NAV_ICON[t.id]}
                </span>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="modal__body">
            {/* Tool-name suggestions shared by the rule and hook editors. */}
            <datalist id="tool-names">
              {TOOL_NAMES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            {page.sections.map((Section, i) => (
              <Section key={`${page.id}-${i}`} ctx={ctx} />
            ))}
          </div>
        </div>

        <div className="modal__foot">
          {storageBlocked && <SecureStorageNotice platform={storageBlocked} />}
          {formError && (
            <span
              role="alert"
              style={{ marginRight: 'auto', color: 'var(--danger)', fontSize: '12px' }}
            >
              {formError}
            </span>
          )}
          {confirmingClose ? (
            <>
              <span style={{ marginRight: 'auto', color: 'var(--text-dim)', fontSize: '13px' }}>
                Discard unsaved changes?
              </span>
              <button className="btn" onClick={() => setConfirmingClose(false)}>
                Keep editing
              </button>
              <button className="btn btn--danger" onClick={onClose}>
                Discard
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={requestClose}>
                Cancel
              </button>
              <button className="btn btn--accent" onClick={save}>
                Save
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
