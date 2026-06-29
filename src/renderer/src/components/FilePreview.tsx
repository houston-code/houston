import { useEffect, useMemo, useState } from 'react'
import type { FilePreview as FilePreviewData } from '@shared/files'
import { humanSize, MAX_PREVIEW_TEXT_BYTES } from '@shared/files'
import { imageDataUrl } from '@shared/images'
import { Markdown } from './Markdown'

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

/**
 * The Files panel's preview pane: renders the selected workspace file in-app.
 * Markdown and SVG render visually (with a Source toggle); other text shows in a
 * line-numbered code pane; supported images render directly; and binary / over-cap
 * / unreadable files fall back to a note pointing at the header's "Reveal" button.
 * Content is fetched (and confined) in the main process.
 */
export function FilePreview({
  workspace,
  path,
  onReveal
}: {
  workspace: string
  path: string | null
  onReveal: (path: string) => void
}): JSX.Element {
  const [data, setData] = useState<FilePreviewData | null>(null)
  const [loading, setLoading] = useState(false)
  // Rich text files (markdown/SVG) open rendered; this toggles to raw source.
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const rich = useMemo<RichKind>(() => (path ? richKindFor(path) : null), [path])

  useEffect(() => {
    setView('rendered')
    if (!path) {
      setData(null)
      return
    }
    let cancelled = false
    setData(null)
    setLoading(true)
    void window.api.readWorkspaceFile(workspace, path).then((d) => {
      if (!cancelled) {
        setData(d)
        setLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [workspace, path])

  // A right-aligned gutter of line numbers, built as one text node (cheap even for
  // a long file) so it scrolls in lockstep with the code beside it.
  const gutter = useMemo(() => {
    if (data?.kind !== 'text') return ''
    const lines = data.text.split('\n').length
    let s = ''
    for (let i = 1; i <= lines; i++) s += `${i}\n`
    return s
  }, [data])

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
          onClick={() => onReveal(path)}
          title="Reveal in the OS file manager"
        >
          Reveal
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
              <Markdown text={data.text} />
            </div>
          ) : rich === 'svg' && view === 'rendered' ? (
            <div className="file-preview__image-wrap">
              <img className="file-preview__image" src={svgDataUrl(data.text)} alt={path} />
            </div>
          ) : (
            <>
              <div className="file-preview__code">
                <pre className="file-preview__gutter" aria-hidden="true">
                  {gutter}
                </pre>
                <pre className="file-preview__text">{data.text}</pre>
              </div>
              {data.truncated && (
                <p className="file-preview__note">
                  Showing the first {humanSize(MAX_PREVIEW_TEXT_BYTES)} of a {humanSize(data.bytes)}{' '}
                  file. Reveal it to open the whole file.
                </p>
              )}
            </>
          )
        ) : data.kind === 'image' ? (
          <div className="file-preview__image-wrap">
            <img className="file-preview__image" src={imageDataUrl(data.image)} alt={path} />
          </div>
        ) : data.kind === 'too-large' ? (
          <p className="file-preview__note">
            This file is {humanSize(data.bytes)} — too large to preview (limit{' '}
            {humanSize(data.limit)}). Reveal it to open in another app.
          </p>
        ) : data.kind === 'binary' ? (
          <p className="file-preview__note">
            Binary file ({humanSize(data.bytes)}) — no text preview. Reveal it to open in another
            app.
          </p>
        ) : (
          <p className="file-preview__note">Couldn’t open this file: {data.message}</p>
        )}
      </div>
    </div>
  )
}
