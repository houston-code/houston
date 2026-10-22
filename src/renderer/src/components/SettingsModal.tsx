import { useCallback, useEffect, useRef, useState } from 'react'
import { SecureStorageNotice, secureStorageBlocked } from './SecureStorageNotice'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useApplyTheme } from '../hooks/useApplyTheme'
import type { AppSettings, PermissionPolicyView } from '@shared/types'
import { PAGES, PAGE_GROUPS, pageById, type TabId } from './settings/pages'
import { NAV_ICON } from './settings/navIcons'
import { TOOL_NAMES } from './settings/permissionRules'
import { SearchableSection } from './settings/SearchableSection'
import { SectionFrame } from './settings/SectionFrame'
import { highlightTerms, queryTerms } from './settings/search'
import { isMacPlatform } from '../lib/shortcuts'
import type { SettingsCtx } from './settings/context'
import { useAutosave } from './settings/useAutosave'

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
  // An action's error (a key, a model fetch, a save), shown inline in the footer.
  const [formError, setFormError] = useState<string | null>(null)
  // Set to the platform when a key save failed because the OS secure store is unusable.
  const [storageBlocked, setStorageBlocked] = useState<string | null>(null)
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

  // Changes save as they are made (text fields when they lose focus); see useAutosave.
  const autosave = useAutosave({
    settings,
    setSettings,
    initial,
    containerRef: bodyRef,
    onSaved,
    onError: setFormError
  })
  const requestClose = onClose
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

  // Apply the chosen theme at once, as the rest of the app will once it saves.
  useApplyTheme(settings.theme ?? 'system')

  // An API key lives in the OS secret store, not settings.json, so saving or removing
  // one is its own action. Merge just the derived key flags from main's response into
  // the working copy, keeping any edit still being typed intact.
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

  // For an action main performs against the stored settings (fetching a provider's
  // models, MCP OAuth): save whatever is pending first so it sees the edits.
  const persistNow = autosave.flush

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

  const navButton = (t: (typeof PAGES)[number]): JSX.Element => {
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
  }

  // A full-window page rather than a box floating over the chat: a dozen pages and a
  // search need the room. Still a modal dialog to assistive tech and the focus trap,
  // since nothing behind it is reachable while it is open; Esc or ✕ returns.
  return (
    <div
      className={`settings-page${mac ? ' settings-page--mac' : ''}`}
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabIndex={-1}
    >
      <div className="settings-page__frame">
        <div className="modal__head settings-page__head">
          {/* The window strip, like the app's own titlebar: the title centered (clear
              of the macOS window controls) and the save state at the right. */}
          <h2 id="settings-title" className="settings-page__title">
            Settings
          </h2>
          <p className={`set-status set-status--${autosave.status}`} aria-live="polite">
            {autosave.status === 'pending' && 'Not saved yet'}
            {autosave.status === 'saving' && 'Saving…'}
            {autosave.status === 'saved' && 'Saved'}
            {autosave.status === 'error' && 'Not saved'}
            {autosave.status === 'saved' && autosave.undo && (
              <button className="link set-status__undo" onClick={autosave.undo}>
                Undo
              </button>
            )}
          </p>
        </div>

        <div className="modal__main">
          <nav className="modal__nav" aria-label="Settings sections">
            {/* The way out leads the sidebar, styled as navigation rather than a button
                beside the title: it is the first thing on the left, and nowhere near
                the macOS window close button, which a far-right ✕ used to invite. */}
            <button className="set-nav__back" onClick={requestClose} title="Back to the app (Esc)">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M10 3.5L5.5 8l4.5 4.5" />
              </svg>
              Back to app
            </button>
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
            {PAGE_GROUPS.map((group) => (
              <div className="set-nav__group" key={group}>
                <div className="set-nav__heading">{group}</div>
                {PAGES.filter((p) => p.group === group).map(navButton)}
              </div>
            ))}
            <div className="set-nav__group set-nav__footer">
              {PAGES.filter((p) => p.group === 'About').map(navButton)}
            </div>
          </nav>

          <div className="modal__body" id="settings-body" ref={bodyRef}>
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
              <>
                <h1 className="set-page__title">{page.label}</h1>
                {page.sections.map((entry) => (
                  <SectionFrame key={`${page.id}-${entry.id}`} entry={entry} ctx={ctx} />
                ))}
              </>
            )}
            {/* After the sections, so the first section stays :first-child (no hairline above it). */}
            {/* Tool-name suggestions shared by the rule and hook editors. */}
            <datalist id="tool-names">
              {TOOL_NAMES.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <p className="sr-only" aria-live="polite">
              {searching ? `${resultCount} ${resultCount === 1 ? 'result' : 'results'}` : ''}
            </p>
          </div>
        </div>

        {(storageBlocked || formError) && (
          <div className="modal__foot">
            {storageBlocked && <SecureStorageNotice platform={storageBlocked} />}
            {formError && (
              <span role="alert" className="set-foot__error">
                {formError}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
