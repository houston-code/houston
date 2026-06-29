import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PreviewServer, PreviewPaneSpec } from '@shared/preview'
import { MAX_PREVIEW_PANES } from '@shared/preview'
import { normalizeManualUrl, selectPreviewPanes } from '../lib/preview'

/**
 * The Preview dock: a resizable right-hand panel that shows the dev servers the
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
export function PreviewDock({
  servers,
  occluded,
  onResizeMouseDown,
  onClose
}: {
  servers: PreviewServer[]
  /** An overlay (modal, palette, find bar) is on top — hide the native views. */
  occluded: boolean
  onResizeMouseDown: (e: React.MouseEvent) => void
  onClose: () => void
}): JSX.Element {
  const [manualUrls, setManualUrls] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)

  const { panes, hiddenCount, startingCount } = selectPreviewPanes(servers, manualUrls)

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
    window.api.syncPreviewPanes(specs, !occluded)
  }, [panes, occluded])

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

  return (
    <aside className="preview-dock" ref={dockRef} aria-label="Preview">
      <div
        className="preview-dock__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize preview panel"
        onMouseDown={onResizeMouseDown}
      />
      <header className="preview-dock__header">
        <span className="preview-dock__title">Preview</span>
        <button
          type="button"
          className="preview-dock__close"
          title="Hide preview panel"
          aria-label="Hide preview panel"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      <div className="preview-dock__body">
        {panes.length === 0 ? (
          <div className="preview-dock__empty">
            {startingCount > 0 ? (
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
            return (
              <div key={pane.id} className="preview-pane">
                <div className="preview-pane__bar">
                  <span className="preview-pane__label" title={pane.label}>
                    {pane.label}
                  </span>
                  <span className="preview-pane__host">{hostport}</span>
                  <span className="preview-pane__actions">
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
                    {pane.kind === 'manual' && (
                      <button
                        type="button"
                        title="Remove"
                        aria-label={`Remove ${hostport}`}
                        onClick={() => removeManual(pane.url)}
                      >
                        ✕
                      </button>
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
    </aside>
  )
}
