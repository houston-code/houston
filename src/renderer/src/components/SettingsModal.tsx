import { useCallback, useEffect, useRef, useState } from 'react'
import { SecureStorageNotice, secureStorageBlocked } from './SecureStorageNotice'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useApplyTheme } from '../hooks/useApplyTheme'
import { applyTheme } from '../lib/theme'
import type { AppSettings, PermissionPolicyView } from '@shared/types'
import { PAGES, PAGE_GROUPS, pageById, type TabId } from './settings/pages'
import { NAV_ICON } from './settings/navIcons'
import { TOOL_NAMES } from './settings/permissionRules'
import { SearchableSection } from './settings/SearchableSection'
import { highlightTerms, queryTerms } from './settings/search'
import { isMacPlatform } from '../lib/shortcuts'
import type { SettingsCtx } from './settings/context'

export { KeyboardTab } from './settings/KeyboardTab'
export type { TabId } from './settings/pages'

export function SettingsModal({
  initial,
  initialTab = 'models',
  initialQuery = '',
  workspace = null,
  onClose,
  onSaved,
  onShowScorecard,
  onShowDoctor
}: {
  initial: AppSettings
  /** The section to open on (e.g. Appearance for /theme). */
  initialTab?: TabId
  /** Open with this settings search already typed (e.g. `/settings proxy`). */
  initialQuery?: string
  /** The open project, whose own permission config is shown beside the user's. */
  workspace?: string | null
  onClose: () => void
  onSaved: (s: AppSettings) => void
  /** Open the local-only per-model loop scorecard (from the Models tab). */
  onShowScorecard?: () => void
  /** Open the setup health check (from About). */
  onShowDoctor?: () => void
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
  // The admin policy and the open project's config, read-only beside the user's own.
  const [policy, setPolicy] = useState<PermissionPolicyView | null>(null)
  useEffect(() => {
    let alive = true
    void window.api
      .getPermissionPolicy(workspace)
      .then((p) => {
        if (alive) setPolicy(p)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [workspace])
  const bodyRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // Settings search. While it has words, the body lists every matching section
  // across all pages instead of the selected page.
  const [query, setQuery] = useState(initialQuery)
  const terms = queryTerms(query)
  const searching = terms.length > 0
  const [matches, setMatches] = useState<Record<string, boolean>>({})
  const onResult = useCallback(
    (id: string, matched: boolean) =>
      setMatches((m) => (m[id] === matched ? m : { ...m, [id]: matched })),
    []
  )

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

  // Mod+F (and / outside a text field) jump to the search box while Settings is
  // open, ahead of the app's own find-in-chat shortcut.
  useEffect(() => {
    const mac = isMacPlatform()
    const onKey = (e: KeyboardEvent): void => {
      const mod = mac ? e.metaKey : e.ctrlKey
      const typing =
        e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]') !== null
      if ((mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') || (e.key === '/' && !typing && !mod)) {
        e.preventDefault()
        e.stopImmediatePropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Esc in a non-empty search box clears it rather than closing Settings. A native
  // listener on the box runs before the dialog's own Esc (the focus trap).
  useEffect(() => {
    const input = searchRef.current
    if (!input) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && input.value !== '') {
        e.stopPropagation()
        setQuery('')
      }
    }
    input.addEventListener('keydown', onKey)
    return () => input.removeEventListener('keydown', onKey)
  }, [])

  // Mark every match in the visible results.
  useEffect(() => {
    const body = bodyRef.current
    if (!body || !searching) return
    return highlightTerms(body, query)
  })

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
    onShowScorecard,
    onShowDoctor,
    workspace,
    policy
  }
  const page = pageById(tab)
  const pageMatches = (id: TabId): number =>
    pageById(id).sections.filter((sec) => matches[sec.id]).length
  const resultCount = PAGES.reduce((n, p) => n + pageMatches(p.id), 0)
  const goToPage = (id: TabId): void => {
    setQuery('')
    setTab(id)
    bodyRef.current?.scrollTo?.({ top: 0 })
  }
  const mac = isMacPlatform()

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
            <div className="set-search" role="search">
              <svg className="set-search__icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" />
                <path d="M10.5 10.5L14 14" />
              </svg>
              <input
                ref={searchRef}
                type="search"
                className="set-search__input"
                placeholder="Search settings"
                aria-label="Search settings"
                aria-controls="settings-body"
                data-autofocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {!query && (
                <kbd className="set-search__kbd" aria-hidden="true">
                  {mac ? '⌘F' : 'Ctrl+F'}
                </kbd>
              )}
            </div>
            {PAGE_GROUPS.map((group) => {
              const pages = PAGES.filter((p) => p.group === group)
              // A group of one page named like the group needs no header of its own.
              const headed = !(pages.length === 1 && pages[0].label === group)
              return (
                <div className="set-nav__group" key={group}>
                  {headed && <div className="set-nav__heading">{group}</div>}
                  {pages.map((t) => {
                    const count = searching ? pageMatches(t.id) : 0
                    const active = !searching && t.id === tab
                    return (
                      <button
                        key={t.id}
                        className={`${active ? 'is-active' : ''}${searching && count === 0 ? ' is-dim' : ''}`}
                        // The highlighted section is otherwise only a color and a rail.
                        aria-current={active ? 'page' : undefined}
                        onClick={() => goToPage(t.id)}
                      >
                        <span className="set-nav__icon" aria-hidden="true">
                          {NAV_ICON[t.id]}
                        </span>
                        {t.label}
                        {searching && count > 0 && (
                          <span className="set-nav__count" aria-label={`${count} ${count === 1 ? 'match' : 'matches'}`}>
                            {count}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </nav>

          <div className="modal__body" id="settings-body" ref={bodyRef}>
            {/* Tool-name suggestions shared by the rule and hook editors. */}
            <datalist id="tool-names">
              {TOOL_NAMES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <p className="sr-only" aria-live="polite">
              {searching ? `${resultCount} ${resultCount === 1 ? 'result' : 'results'}` : ''}
            </p>
            {searching ? (
              <>
                {PAGES.map((p) => (
                  <section key={p.id} className="set-results__page" hidden={pageMatches(p.id) === 0} aria-label={p.label}>
                    <h2 className="set-results__title">
                      <button className="link" onClick={() => goToPage(p.id)}>
                        {p.label}
                      </button>
                    </h2>
                    {p.sections.map((entry) => (
                      <SearchableSection
                        key={entry.id}
                        entry={entry}
                        pageLabel={p.label}
                        terms={terms}
                        ctx={ctx}
                        onResult={onResult}
                      />
                    ))}
                  </section>
                ))}
                {resultCount === 0 && (
                  <div className="set-results__empty">
                    <p>No settings match &ldquo;{query.trim()}&rdquo;.</p>
                    <p className="settings-dim">Try a broader word, like &ldquo;key&rdquo;, &ldquo;network&rdquo;, or &ldquo;theme&rdquo;.</p>
                  </div>
                )}
              </>
            ) : (
              page.sections.map(({ id, Component }) => <Component key={`${page.id}-${id}`} ctx={ctx} />)
            )}
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
