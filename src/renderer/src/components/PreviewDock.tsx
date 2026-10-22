import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PreviewServer, PreviewPaneSpec } from '@shared/preview'
import { MAX_PREVIEW_PANES } from '@shared/preview'
import { normalizeManualUrl, selectPreviewPanes } from '../lib/preview'
import { copyText } from '../lib/clipboard'
import { describeShell } from '../lib/taskLabel'

/**
 * The right-hand dock. With `onTabChange` it has two tabs, Preview and Tasks (the
 * background-tasks list, passed in as `tasks`); without, it is Preview-only.
 *
 * Preview: a resizable right-hand panel that shows the dev servers the
 * agent started (each one's loopback URL, auto-detected from its output) as live,
 * scrollable pages, stacked top-to-bottom and capped at three.
 *
 * The pages themselves are native WebContentsViews owned by the main process
 * (see main/preview.ts) — they can't live in the DOM securely — so this component
 * renders an empty placeholder per pane and reports each placeholder's rectangle
 * to main, which paints the matching view there. Because a native view always
 * paints above the window's HTML, we report `visible:false` whenever an overlay is
 * on top (`occluded`) so a preview never covers a modal; main keeps the view alive
 * but hidden. Unmounting (the dock closed) tears every pane down.
 */
export type DockTab = 'preview' | 'tasks'

export function PreviewDock({
  servers,
  occluded,
  onResizeMouseDown,
  onClose,
  tab = 'preview',
  onTabChange,
  tasks,
  taskCount = 0,
  focusServerId = null,
  focusRequest
}: {
  servers: PreviewServer[]
  /** An overlay (modal, palette, find bar) is on top — hide the native views. */
  occluded: boolean
  onResizeMouseDown: (e: React.MouseEvent) => void
  onClose: () => void
  /** Which tab the dock shows. Defaults to Preview. */
  tab?: DockTab
  /** Switch tabs. Without it the dock is Preview-only (no tab strip). */
  onTabChange?: (tab: DockTab) => void
  /** The Tasks tab's content (the TasksPanel). */
  tasks?: ReactNode
  /** Live background tasks, shown as a count on the Tasks tab. */
  taskCount?: number
  /** A server to keep on screen even past the pane cap (Tasks' "Open preview"). */
  focusServerId?: string | null
  /** Changes identity on every "Open preview", so a repeat request for the same server
   *  still reopens its pane if the user closed it. */
  focusRequest?: object | null
}): JSX.Element {
  // While Tasks is showing, Preview stays mounted (its pages and added URLs survive
  // the switch) but its native views are hidden, exactly as under an overlay.
  const previewVisible = tab === 'preview'
  const tabRefs = useRef<Record<DockTab, HTMLButtonElement | null>>({ preview: null, tasks: null })
  const [manualUrls, setManualUrls] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState(false)
  // Which of a server's printed URLs each pane shows, when the user switched it.
  const [chosen, setChosen] = useState<Record<string, string>>({})
  // Servers whose pane the user closed. The server keeps running (Tasks stops it); its
  // pane just stops taking a slot until reopened.
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  // The pane whose URL was just copied, for a moment of "Copied" feedback.
  const [copied, setCopied] = useState<string | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dockRef = useRef<HTMLDivElement>(null)

  // Tasks' "Open preview" names a server: reopen it if its pane was closed.
  useEffect(() => {
    if (!focusServerId) return
    setClosed((prev) => {
      if (!prev.has(focusServerId)) return prev
      const next = new Set(prev)
      next.delete(focusServerId)
      return next
    })
  }, [focusServerId, focusRequest])

  const closedCount = servers.filter((s) => closed.has(s.id) && s.running && s.url).length
  const { panes, hiddenCount, startingCount } = selectPreviewPanes(
    servers.filter((s) => !closed.has(s.id)),
    manualUrls,
    MAX_PREVIEW_PANES,
    chosen,
    focusServerId
  )

  // Placeholder elements keyed by pane id; the native view is positioned over each.
  const slots = useRef(new Map<string, HTMLDivElement>())
  const setSlot = useCallback(
    (id: string) =>
      (el: HTMLDivElement | null): void => {
        if (el) slots.current.set(id, el)
        else slots.current.delete(id)
      },
    []
  )

  // Measure each placeholder and tell main where to paint (and whether to show)
  // the native views. Runs after every layout change and on every resize.
  const sync = useCallback(() => {
    const specs: PreviewPaneSpec[] = []
    for (const pane of panes) {
      const el = slots.current.get(pane.id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      specs.push({
        id: pane.id,
        url: pane.url,
        bounds: { x: r.left, y: r.top, width: r.width, height: r.height }
      })
    }
    window.api.syncPreviewPanes(specs, !occluded && previewVisible)
  }, [panes, occluded, previewVisible])

  useLayoutEffect(() => {
    sync()
  }, [sync])

  // Re-measure when the dock or window changes size (width drag, window resize).
  useEffect(() => {
    const ro = new ResizeObserver(() => sync())
    const dock = dockRef.current
    if (dock) ro.observe(dock)
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
    }
  }, [sync])

  // Tear every native pane down when the dock unmounts (closed).
  useEffect(() => () => window.api.syncPreviewPanes([], false), [])
  // Don't let the "Copied" reset fire into a dock that has closed.
  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
    },
    []
  )

  const addManual = useCallback(() => {
    const url = normalizeManualUrl(draft)
    if (!url) {
      setDraftError(true)
      return
    }
    setManualUrls((prev) => (prev.includes(url) ? prev : [...prev, url]))
    setDraft('')
    setDraftError(false)
  }, [draft])

  const removeManual = useCallback((url: string) => {
    setManualUrls((prev) => prev.filter((u) => u !== url))
  }, [])

  const closeServer = useCallback((id: string) => {
    setClosed((prev) => new Set(prev).add(id))
  }, [])

  return (
    <aside className="preview-dock" ref={dockRef} aria-label={onTabChange ? 'Side panel' : 'Preview'}>
      <div
        className="preview-dock__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview panel"
        onMouseDown={onResizeMouseDown}
      />
      <header className="preview-dock__header">
        {onTabChange ? (
          <div className="dock-tabs" role="tablist" aria-label="Side panel">
            {(['preview', 'tasks'] as const).map((id) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el
                }}
                type="button"
                role="tab"
                id={`dock-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`dock-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className={`dock-tabs__tab${tab === id ? ' dock-tabs__tab--active' : ''}`}
                onClick={() => onTabChange(id)}
                onKeyDown={(e) => {
                  // Arrow keys move between tabs (roving tabindex), per the ARIA tabs pattern.
                  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End')
                    return
                  e.preventDefault()
                  const next: DockTab =
                    e.key === 'Home' ? 'preview' : e.key === 'End' ? 'tasks' : id === 'preview' ? 'tasks' : 'preview'
                  onTabChange(next)
                  tabRefs.current[next]?.focus()
                }}
              >
                {id === 'preview' ? 'Preview' : 'Tasks'}
                {id === 'tasks' && taskCount > 0 && (
                  <span className="dock-tabs__count" aria-label={`${taskCount} running`}>
                    {taskCount}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <span className="preview-dock__title">Preview</span>
        )}
        <button
          type="button"
          className="preview-dock__close"
          title={onTabChange ? 'Hide side panel' : 'Hide preview panel'}
          aria-label={onTabChange ? 'Hide side panel' : 'Hide preview panel'}
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div
        className="preview-dock__panel"
        {...(onTabChange
          ? { role: 'tabpanel', id: 'dock-panel-preview', 'aria-labelledby': 'dock-tab-preview' }
          : {})}
        hidden={!previewVisible}
      >
        <div className="preview-dock__body">
          {panes.length === 0 ? (
            <div className="preview-dock__empty">
              {closedCount > 0 ? (
                <p>All previews are closed. Their servers are still running.</p>
              ) : startingCount > 0 ? (
                <p>Waiting for a server to report its URL…</p>
              ) : (
                <>
                  <p>No running dev servers.</p>
                  <p className="preview-dock__hint">
                    Ask the agent to start one (e.g. <code>npm run dev</code>), or add a localhost URL
                    below.
                  </p>
                </>
              )}
            </div>
          ) : (
            panes.map((pane) => {
              let hostport = pane.url
              try {
                hostport = new URL(pane.url).host
              } catch {
                /* keep the raw URL */
              }
              const serverId = pane.id.startsWith('server:') ? pane.id.slice('server:'.length) : null
              return (
                <div key={pane.id} className="preview-pane">
                  <div className="preview-pane__bar">
                    {/* A server pane is labeled by the command that runs it, minus setup steps
                        like `cd /abs/path &&`; hover shows the full command. */}
                    <span className="preview-pane__label" title={pane.label}>
                      {pane.kind === 'manual' ? pane.label : describeShell(pane.label).label}
                    </span>
                    {/* The whole URL, scheme included, so what shows is what the arrow opens
                        and what a copy pastes into a browser. */}
                    {pane.urls && serverId ? (
                      <select
                        className="preview-pane__host preview-pane__host--select"
                        aria-label={`Address shown for ${pane.label}`}
                        title="This server printed more than one address"
                        value={pane.url}
                        onChange={(e) => setChosen((prev) => ({ ...prev, [serverId]: e.target.value }))}
                      >
                        {pane.urls.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="preview-pane__host" title={pane.url}>
                        {pane.url}
                      </span>
                    )}
                    <span className="preview-pane__actions">
                      <button
                        type="button"
                        title={copied === pane.id ? 'Copied' : 'Copy URL'}
                        aria-label={copied === pane.id ? `Copied ${pane.url}` : `Copy ${pane.url}`}
                        onClick={() =>
                          void copyText(pane.url).then((ok) => {
                            if (!ok) return
                            setCopied(pane.id)
                            if (copiedTimer.current) clearTimeout(copiedTimer.current)
                            copiedTimer.current = setTimeout(() => setCopied(null), 1500)
                          })
                        }
                      >
                        {copied === pane.id ? '✓' : '⧉'}
                      </button>
                      <button
                        type="button"
                        title="Reload"
                        aria-label={`Reload ${hostport}`}
                        onClick={() => window.api.reloadPreviewPane(pane.id)}
                      >
                        ⟳
                      </button>
                      <button
                        type="button"
                        title="Open in browser"
                        aria-label={`Open ${hostport} in browser`}
                        onClick={() => void window.api.openPreviewExternal(pane.url)}
                      >
                        ↗
                      </button>
                      {pane.kind === 'manual' ? (
                        <button
                          type="button"
                          title="Remove"
                          aria-label={`Remove ${hostport}`}
                          onClick={() => removeManual(pane.url)}
                        >
                          ✕
                        </button>
                      ) : (
                        serverId && (
                          <button
                            type="button"
                            title="Close preview (the server keeps running)"
                            aria-label={`Close preview of ${hostport}`}
                            onClick={() => closeServer(serverId)}
                          >
                            ✕
                          </button>
                        )
                      )}
                    </span>
                  </div>
                  {/* The native WebContentsView is positioned over this box by main. */}
                  <div className="preview-pane__view" ref={setSlot(pane.id)} />
                </div>
              )
            })
          )}
        </div>

        {hiddenCount > 0 && (
          <div className="preview-dock__overflow">
            +{hiddenCount} more not shown (max {MAX_PREVIEW_PANES})
          </div>
        )}
        {closedCount > 0 && (
          <div className="preview-dock__overflow">
            {closedCount === 1 ? '1 preview closed' : `${closedCount} previews closed`}.{' '}
            <button type="button" className="preview-dock__reopen" onClick={() => setClosed(new Set())}>
              Show {closedCount === 1 ? 'it' : 'them'}
            </button>
          </div>
        )}

        <form
          className="preview-dock__add"
          onSubmit={(e) => {
            e.preventDefault()
            addManual()
          }}
        >
          <input
            type="text"
            className={`preview-dock__input${draftError ? ' preview-dock__input--error' : ''}`}
            placeholder="Add a localhost URL or port…"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setDraftError(false)
            }}
            aria-label="Add a localhost URL to preview"
            aria-invalid={draftError}
          />
          <button type="submit" className="btn btn--sm" disabled={!draft.trim()}>
            Add
          </button>
        </form>
      </div>

      {onTabChange && (
        <div
          className="preview-dock__panel preview-dock__panel--tasks"
          role="tabpanel"
          id="dock-panel-tasks"
          aria-labelledby="dock-tab-tasks"
          hidden={tab !== 'tasks'}
        >
          {tasks}
        </div>
      )}
    </aside>
  )
}
