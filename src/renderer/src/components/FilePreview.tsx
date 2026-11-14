import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FilePreview as FilePreviewData } from '@shared/files'
import { humanSize, MAX_PREVIEW_TEXT_BYTES } from '@shared/files'
import { cachedImageDataUrl } from '../lib/imageUrl'
import { highlightFile } from '../lib/highlight'
import { Markdown } from './Markdown'
import { VisualsContext } from '../lib/visuals'

const NO_HTML_VISUALS = { html: false }

/** Text files that can also render visually, with a Source/Preview toggle. */
type RichKind = 'markdown' | 'svg' | null

function richKindFor(path: string): RichKind {
  const m = /\.([A-Za-z0-9]+)$/.exec(path)
  const ext = m ? m[1].toLowerCase() : ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'svg') return 'svg'
  return null
}

/**
 * An `<img>`-safe data URL for inline SVG source. Rendered via `<img>` (not
 * inlined into the DOM), so any embedded script never executes.
 */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** Whether two reads of a file show the same thing. */
function samePreview(a: FilePreviewData, b: FilePreviewData): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'text' && b.kind === 'text') return a.text === b.text && a.truncated === b.truncated && a.bytes === b.bytes
  if (a.kind === 'image' && b.kind === 'image') return a.bytes === b.bytes && a.image.data === b.image.data
  if (a.kind === 'error' && b.kind === 'error') return a.message === b.message
  if (a.kind === 'too-large' && b.kind === 'too-large') return a.bytes === b.bytes && a.limit === b.limit
  return a.kind === 'binary' && b.kind === 'binary' && a.bytes === b.bytes
}

/**
 * The Files panel's preview pane: renders the selected workspace file in-app.
 * Markdown and SVG render visually (with a Source toggle); other text shows in a
 * line-numbered code pane; supported images render directly; and binary / over-cap
 * / unreadable files fall back to a note pointing at the header's "Open" button.
 * Content is fetched (and confined) in the main process.
 */
export function FilePreview({
  workspace,
  path,
  onOpen,
  line,
  reloadSignal = 0
}: {
  workspace: string
  path: string | null
  onOpen: (path: string) => void
  /** A 1-based line to scroll to and mark (a link that named one). Shows the source view. */
  line?: number
  /** Bumped to re-read the same file in place (the panel's Refresh). */
  reloadSignal?: number
}): JSX.Element {
  const [data, setData] = useState<FilePreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  // Rich text files (markdown/SVG) open rendered; this toggles to raw source.
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const rich = useMemo<RichKind>(() => (path ? richKindFor(path) : null), [path])

  // A new file (or line) starts over; a reload of the same one keeps showing what it
  // has until the fresh read lands, and keeps the view (rendered or source) as chosen.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    const key = `${workspace}\0${path ?? ''}\0${line ?? ''}`
    const fresh = key !== shown.current
    shown.current = key
    if (fresh) setView(line ? 'source' : 'rendered')
    if (!path) {
      setData(null)
      return
    }
    let cancelled = false
    if (fresh) setData(null)
    setLoading(true)
    void window.api.readWorkspaceFile(workspace, path).then((d) => {
      if (!cancelled) {
        // An unchanged file keeps its object, so nothing re-renders or re-scrolls.
        setData((prev) => (prev && samePreview(prev, d) ? prev : d))
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [workspace, path, line, reloadSignal])

  // Scroll a named line into view and mark it. Lines are a fixed height in the code
  // pane (no wrapping), so its offset is the line index times the line height.
  const codeRef = useRef<HTMLDivElement>(null)
  const markRef = useRef<HTMLDivElement>(null)
  const lineCount = data?.kind === 'text' ? data.text.split('\n').length : 0
  const markLine = line && line <= lineCount ? line : undefined
  useLayoutEffect(() => {
    const code = codeRef.current
    const mark = markRef.current
    if (!code || !mark || !markLine) return
    const text = code.querySelector<HTMLElement>('.file-preview__text')
    if (!text) return
    const style = getComputedStyle(text)
    const lineHeight = parseFloat(style.lineHeight) || 18
    const top = (parseFloat(style.paddingTop) || 0) + (markLine - 1) * lineHeight
    mark.style.top = `${top}px`
    mark.style.height = `${lineHeight}px`
    mark.scrollIntoView?.({ block: 'center' })
  }, [markLine, data, view])

  // A right-aligned gutter of line numbers, built as one text node (cheap even for
  // a long file) so it scrolls in lockstep with the code beside it.
  const gutter = useMemo(() => {
    if (data?.kind !== 'text') return ''
    const lines = data.text.split('\n').length
    let s = ''
    for (let i = 1; i <= lines; i++) s += `${i}\n`
    return s
  }, [data])

  // Syntax-highlighted HTML for the code pane, or null to render the raw text
  // (unknown language, too large, or hljs failed). hljs escapes its input.
  const highlighted = useMemo(
    () => (path && data?.kind === 'text' ? highlightFile(path, data.text) : null),
    [path, data]
  )

  if (!path) {
    return (
      <div className="file-preview file-preview--empty">
        <p className="file-preview__note">Select a file to preview it here.</p>
      </div>
    )
  }

  return (
    <div className="file-preview">
      <div className="file-preview__head">
        <span className="file-preview__path" title={path}>
          {path}
        </span>
        {data && data.kind !== 'error' && (
          <span className="file-preview__size">{humanSize(data.bytes)}</span>
        )}
        {data?.kind === 'text' && rich && data.text.length > 0 && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => setView((v) => (v === 'rendered' ? 'source' : 'rendered'))}
            title={view === 'rendered' ? 'Show the raw source' : 'Show the rendered view'}
          >
            {view === 'rendered' ? 'Source' : 'Preview'}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onOpen(path)}
          title="Open in the default app"
        >
          Open
        </button>
      </div>
      <div className="file-preview__body">
        {loading && !data ? (
          <p className="file-preview__note">Loading…</p>
        ) : !data ? null : data.kind === 'text' ? (
          data.text.length === 0 ? (
            <p className="file-preview__note">This file is empty.</p>
          ) : rich === 'markdown' && view === 'rendered' ? (
            <div className="file-preview__markdown">
              {/* A repo's own markdown: diagrams and SVG render, but its HTML never runs. */}
              <VisualsContext.Provider value={NO_HTML_VISUALS}>
                <Markdown text={data.text} visuals />
              </VisualsContext.Provider>
            </div>
          ) : rich === 'svg' && view === 'rendered' ? (
            <div className="file-preview__image-wrap">
              <img className="file-preview__image" src={svgDataUrl(data.text)} alt={path} />
            </div>
          ) : (
            <>
              <div className="file-preview__code" ref={codeRef}>
                {markLine && (
                  <div
                    ref={markRef}
                    className="file-preview__line-mark"
                    data-line={markLine}
                    aria-label={`Line ${markLine}`}
                  />
                )}
                <pre className="file-preview__gutter" aria-hidden="true">
                  {gutter}
                </pre>
                {highlighted != null ? (
                  <pre
                    className="file-preview__text hljs"
                    dangerouslySetInnerHTML={{ __html: highlighted }}
                  />
                ) : (
                  <pre className="file-preview__text">{data.text}</pre>
                )}
              </div>
              {data.truncated && (
                <p className="file-preview__note">
                  Showing the first {humanSize(MAX_PREVIEW_TEXT_BYTES)} of a {humanSize(data.bytes)}{' '}
                  file. Open it to view the whole file.
                </p>
              )}
            </>
          )
        ) : data.kind === 'image' ? (
          <div className="file-preview__image-wrap">
            <img className="file-preview__image" src={cachedImageDataUrl(data.image)} alt={path} />
          </div>
        ) : data.kind === 'too-large' ? (
          <p className="file-preview__note">
            This file is {humanSize(data.bytes)}, too large to preview (limit{' '}
            {humanSize(data.limit)}). Open it to view in another app.
          </p>
        ) : data.kind === 'binary' ? (
          <p className="file-preview__note">
            Binary file ({humanSize(data.bytes)}): no text preview. Open it to view in another
            app.
          </p>
        ) : (
          <p className="file-preview__note">Couldn’t open this file: {data.message}</p>
        )}
      </div>
    </div>
  )
}
